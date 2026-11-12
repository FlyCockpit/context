import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  encodeEd25519,
  fingerprintOf,
  OPENSSH_PRIVATE_KEY_ARMOR,
  parsePublicKey,
  parsePublicKeyLine,
} from "./openssh";

const exec = promisify(execFile);
const hasSshKeygen = await exec("ssh-keygen", ["-?"]).then(
  () => true,
  (error: { stderr?: string }) => /usage/i.test(error.stderr ?? ""),
);

const GITHUB_ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cockpit-context-openssh-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function generate() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return encodeEd25519(
    Buffer.from(jwk.d ?? "", "base64url"),
    Buffer.from(jwk.x ?? "", "base64url"),
    "cockpit-context",
  );
}

describe("fingerprintOf", () => {
  it("matches GitHub's published ed25519 fingerprint", () => {
    expect(fingerprintOf(GITHUB_ED25519)).toBe(
      "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    );
  });
});

describe("parsePublicKey", () => {
  it("accepts a supported key whose blob carries the same type", () => {
    expect(parsePublicKey("ssh-ed25519", GITHUB_ED25519)?.keyType).toBe("ssh-ed25519");
    expect(parsePublicKeyLine(`ssh-ed25519 ${GITHUB_ED25519} comment`)?.publicKey).toBe(
      GITHUB_ED25519,
    );
  });

  it("rejects relabeled, unsupported or non-canonical keys", () => {
    expect(parsePublicKey("ssh-rsa", GITHUB_ED25519)).toBeNull();
    expect(parsePublicKey("ssh-dss", GITHUB_ED25519)).toBeNull();
    expect(parsePublicKey("ssh-ed25519", `${GITHUB_ED25519}==`)).toBeNull();
    expect(parsePublicKey("ssh-ed25519", "not base64!")).toBeNull();
  });
});

describe("encodeEd25519", () => {
  it("produces a public line whose fingerprint matches its blob", () => {
    const key = generate();
    expect(key.privateKey.startsWith(`${OPENSSH_PRIVATE_KEY_ARMOR.begin}\n`)).toBe(true);
    const parsed = parsePublicKeyLine(key.publicKeyLine);
    expect(parsed).toEqual(key.publicKey);
  });

  it.skipIf(!hasSshKeygen)(
    "writes a private key ssh-keygen accepts and derives the same public key from",
    async () => {
      const key = generate();
      const file = path.join(dir, "id_ed25519");
      await writeFile(file, key.privateKey, { mode: 0o600 });
      const { stdout } = await exec("ssh-keygen", ["-y", "-f", file]);
      expect(stdout.trim()).toBe(key.publicKeyLine);
      const { stdout: fp } = await exec("ssh-keygen", ["-l", "-E", "sha256", "-f", file]);
      expect(fp).toContain(key.publicKey.fingerprint);
    },
  );
});
