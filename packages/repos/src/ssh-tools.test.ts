import type { execFile as ExecFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnRecord = {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Modes of the askpass dir, helper and socket at spawn time. */
  askpassModes?: { dir: number; helper: number; socket: number };
};
type FakeExecFile = (
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

const state = vi.hoisted(() => ({
  dataDir: "",
  failSocketChmod: false,
  closedSockets: 0,
  spawned: [] as SpawnRecord[],
  fake: undefined as FakeExecFile | undefined,
}));
vi.mock("./config", () => ({ dataDir: () => state.dataDir, gitHostAllowlist: () => [] }));
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      server.on("close", () => {
        state.closedSockets += 1;
      });
      return server;
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (state.failSocketChmod && String(args[0]).endsWith("phrase.sock"))
        throw new Error("permission failure");
      return actual.chmod(...args);
    },
  };
});

// Record every spawn (argv, env, the askpass files' modes) and pass it on to
// the real execFile, unless a test installs a fake.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const recording = (
    file: string,
    args: readonly string[],
    options: { env: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const record: SpawnRecord = { file, args: [...args], env: { ...options.env } };
    const helper = options.env.SSH_ASKPASS;
    if (helper && helper !== "/bin/false") {
      const mode = (target: string) => statSync(target).mode & 0o777;
      record.askpassModes = {
        dir: mode(path.dirname(helper)),
        helper: mode(helper),
        socket: mode(path.join(path.dirname(helper), "phrase.sock")),
      };
    }
    state.spawned.push(record);
    if (state.fake) {
      state.fake(args, callback);
      return { stdin: { end() {} } };
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(file, args, options, callback);
  };
  return { ...actual, execFile: recording };
});

const { normalizeImportedPrivateKey, parseKeyscanOutput } = await import("./ssh-tools");
const { OPENSSH_PRIVATE_KEY_ARMOR, pemArmor } = await import("./openssh");
const { RepoError } = await import("./errors");

const actualChildProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const exec = promisify(actualChildProcess.execFile as typeof ExecFile);
const hasSshKeygen = await exec("ssh-keygen", ["-?"]).then(
  () => true,
  (error: { stderr?: string }) => /usage/i.test(error.stderr ?? ""),
);
if (!hasSshKeygen) {
  console.warn(
    "ssh-tools.test.ts: ssh-keygen is not installed; skipping the real ssh-keygen round trips (install openssh-client).",
  );
}

/*
 * Every test gets its own data dir and key dir, created in beforeEach and
 * removed in afterEach. A test that times out under a loaded turbo run can
 * leave its ssh-keygen child writing for a while; with private directories
 * those files can never make a later test's `tmpIsEmpty()` fail.
 */
let keysDir: string;

beforeEach(async () => {
  state.dataDir = await mkdtemp(path.join(tmpdir(), "cockpit-context-ssh-tools-data-"));
  keysDir = await mkdtemp(path.join(tmpdir(), "cockpit-context-ssh-tools-keys-"));
  state.spawned.length = 0;
  state.fake = undefined;
  state.failSocketChmod = false;
  state.closedSockets = 0;
});

afterEach(async () => {
  state.spawned.length = 0;
  state.fake = undefined;
  await rm(state.dataDir, { recursive: true, force: true });
  await rm(keysDir, { recursive: true, force: true });
});

async function makeKey(
  name: string,
  args: string[],
): Promise<{ privateKey: string; publicLine: string }> {
  const file = path.join(keysDir, name);
  await exec("ssh-keygen", ["-q", "-C", "fixture", "-f", file, ...args]);
  return {
    privateKey: await readFile(file, "utf8"),
    publicLine: (await readFile(`${file}.pub`, "utf8")).trim(),
  };
}

/** No per-invocation dir is left under this test's COCKPIT_CONTEXT_DATA_DIR/tmp. */
async function tmpIsEmpty(): Promise<boolean> {
  const entries = await readdir(path.join(state.dataDir, "tmp")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries.length === 0;
}

/*
 * Real ssh-keygen round trips (key generation, bcrypt KDF rounds, RSA 2048)
 * take a few hundred milliseconds idle and several seconds on a loaded
 * uncached turbo run, past vitest's 5 s default. ssh-tools' own TOOL_TIMEOUT_MS
 * is 15 s per call, so the budget covers a few calls at that bound.
 */
const REAL_SSH_KEYGEN_TIMEOUT_MS = 60_000;

describe.skipIf(!hasSshKeygen)(
  "normalizeImportedPrivateKey",
  { timeout: REAL_SSH_KEYGEN_TIMEOUT_MS },
  () => {
    it("accepts an unencrypted OpenSSH ed25519 key", async () => {
      const key = await makeKey("plain", ["-t", "ed25519", "-N", ""]);
      const result = await normalizeImportedPrivateKey(key.privateKey, undefined);
      expect(result.publicKey.keyType).toBe("ssh-ed25519");
      expect(key.publicLine).toContain(result.publicKey.publicKey);
      expect(result.privateKey.startsWith(OPENSSH_PRIVATE_KEY_ARMOR.begin)).toBe(true);
      expect(await tmpIsEmpty()).toBe(true);
    });

    it("hands the passphrase over through askpass, never argv or env", async () => {
      const passphrase = "s3cret $(touch pwned) 'quoted' \"double\" ; `tick` \\ ñ";
      const key = await makeKey("askpass", ["-t", "ed25519", "-N", passphrase]);
      state.spawned.length = 0;
      const result = await normalizeImportedPrivateKey(key.privateKey, passphrase);
      expect(key.publicLine).toContain(result.publicKey.publicKey);

      expect(state.spawned.map((call) => call.args[0] ?? "")).toEqual(["-q", "-y"]);
      for (const call of state.spawned) {
        expect(call.file).toBe("ssh-keygen");
        for (const arg of call.args) expect(arg).not.toContain(passphrase);
        for (const value of Object.values(call.env)) expect(value ?? "").not.toContain(passphrase);
        expect(call.env.SSH_ASKPASS_REQUIRE).toBe("force");
      }
      const [rewrite, derive] = state.spawned;
      expect(rewrite?.args).not.toContain("-P");
      const helper = rewrite?.env.SSH_ASKPASS ?? "";
      expect(helper.startsWith(path.join(tmpdir(), "cockpit-context-ap-"))).toBe(true);
      expect(existsSync(path.join(path.dirname(helper), "passphrase"))).toBe(false);
      expect(rewrite?.askpassModes).toEqual({ dir: 0o700, helper: 0o700, socket: 0o600 });
      expect(derive?.env.SSH_ASKPASS).toBe("/bin/false");
      // The helper's directory (socket, script) is gone afterwards.
      expect(() => statSync(path.dirname(helper))).toThrow();
      expect(await tmpIsEmpty()).toBe(true);
    });

    it("imports an encrypted key with a data directory longer than a Unix socket path", async () => {
      state.dataDir = path.join(state.dataDir, "long-data-directory-".repeat(12));
      const key = await makeKey("long-path", ["-t", "ed25519", "-N", "long path phrase"]);
      const result = await normalizeImportedPrivateKey(key.privateKey, "long path phrase");
      expect(key.publicLine).toContain(result.publicKey.publicKey);
      const helper = state.spawned[0]?.env.SSH_ASKPASS ?? "";
      expect(Buffer.byteLength(path.join(path.dirname(helper), "phrase.sock"))).toBeLessThan(104);
      expect(state.spawned[0]?.askpassModes).toEqual({ dir: 0o700, helper: 0o700, socket: 0o600 });
      expect(existsSync(path.dirname(helper))).toBe(false);
      expect(await tmpIsEmpty()).toBe(true);
      state.dataDir = path.dirname(state.dataDir);
    });

    it("refuses a wrong passphrase without echoing it", async () => {
      const key = await makeKey("wrong", ["-t", "ed25519", "-N", "the right one"]);
      const error = await normalizeImportedPrivateKey(key.privateKey, "not-the-passphrase").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RepoError);
      expect(error).toMatchObject({ code: "SSH_KEY_PASSPHRASE_INVALID" });
      expect(String((error as Error).message)).not.toContain("not-the-passphrase");
      expect(JSON.stringify(error)).not.toContain("not-the-passphrase");
      for (const call of state.spawned) {
        expect(call.args.join("\n")).not.toContain("not-the-passphrase");
        for (const value of Object.values(call.env)) {
          expect(value ?? "").not.toContain("not-the-passphrase");
        }
      }
      expect(await tmpIsEmpty()).toBe(true);
    });

    it("decrypts a passphrase-protected key", async () => {
      const key = await makeKey("encrypted", ["-t", "ed25519", "-N", "correct horse"]);
      await expect(normalizeImportedPrivateKey(key.privateKey, undefined)).rejects.toMatchObject({
        code: "SSH_KEY_PASSPHRASE_REQUIRED",
      });
      await expect(normalizeImportedPrivateKey(key.privateKey, "wrong")).rejects.toMatchObject({
        code: "SSH_KEY_PASSPHRASE_INVALID",
      });
      const result = await normalizeImportedPrivateKey(key.privateKey, "correct horse");
      expect(key.publicLine).toContain(result.publicKey.publicKey);
      // The stored form is unencrypted (it is re-encrypted under our keyring instead).
      const reloaded = await normalizeImportedPrivateKey(result.privateKey, undefined);
      expect(reloaded.publicKey).toEqual(result.publicKey);
      expect(await tmpIsEmpty()).toBe(true);
    });

    it("converts a PEM RSA key to OpenSSH format", async () => {
      const key = await makeKey("rsa", ["-t", "rsa", "-b", "2048", "-m", "PEM", "-N", ""]);
      expect(key.privateKey.startsWith(pemArmor("RSA PRIVATE KEY").begin)).toBe(true);
      const result = await normalizeImportedPrivateKey(key.privateKey, undefined);
      expect(result.publicKey.keyType).toBe("ssh-rsa");
      expect(result.privateKey.startsWith(OPENSSH_PRIVATE_KEY_ARMOR.begin)).toBe(true);
    });

    it("rejects garbage and non-keys", async () => {
      await expect(normalizeImportedPrivateKey("hello", undefined)).rejects.toMatchObject({
        code: "SSH_KEY_INVALID",
      });
      await expect(
        normalizeImportedPrivateKey(
          `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nAAAA\n${OPENSSH_PRIVATE_KEY_ARMOR.end}`,
          undefined,
        ),
      ).rejects.toMatchObject({ code: "SSH_KEY_INVALID" });
      expect(await tmpIsEmpty()).toBe(true);
    });
  },
);

describe("normalizeImportedPrivateKey failure paths", () => {
  const pastedKey = `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nAAAA\n${OPENSSH_PRIVATE_KEY_ARMOR.end}`;

  it("removes the askpass files when ssh-keygen is killed on timeout", async () => {
    state.fake = (_args, callback) => {
      const killed = Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGKILL",
        code: null,
      });
      callback(killed, "", "");
    };
    await expect(normalizeImportedPrivateKey(pastedKey, "pass phrase")).rejects.toMatchObject({
      code: "SSH_KEY_INVALID",
    });
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0]?.askpassModes).toEqual({
      dir: 0o700,
      helper: 0o700,
      socket: 0o600,
    });
    expect(existsSync(path.dirname(state.spawned[0]?.env.SSH_ASKPASS ?? ""))).toBe(false);
    expect(await tmpIsEmpty()).toBe(true);
  });

  it("reports a helper that cannot run as a server fault, not a passphrase error", async () => {
    state.fake = (args, callback) => {
      const keyPath = args.at(-1) ?? "";
      callback(
        Object.assign(new Error("Command failed"), { code: 1 }),
        "",
        `ssh_askpass: exec(${path.join(path.dirname(keyPath), "askpass")}): Permission denied\n` +
          `Failed to load key ${keyPath}: incorrect passphrase supplied to decrypt private key\n`,
      );
    };
    const error = await normalizeImportedPrivateKey(pastedKey, "pass phrase").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RepoError);
    expect((error as Error).message).toMatch(/askpass/);
    expect((error as Error).message).not.toContain("pass phrase");
    expect(await tmpIsEmpty()).toBe(true);
  });

  it("refuses a passphrase with a line break or NUL before spawning anything", async () => {
    for (const passphrase of ["one\ntwo", "one\rtwo", "one\0two"]) {
      await expect(normalizeImportedPrivateKey(pastedKey, passphrase)).rejects.toMatchObject({
        code: "SSH_KEY_PASSPHRASE_LINE_BREAK",
      });
    }
    expect(state.spawned).toHaveLength(0);
  });

  it("refuses a passphrase over 1023 UTF-8 bytes before spawning anything", async () => {
    // 511 two-byte characters plus one ASCII byte is exactly the limit.
    state.fake = (_args, callback) =>
      callback(
        Object.assign(new Error("Command failed"), { code: 255 }),
        "",
        "Failed to load key: incorrect passphrase supplied to decrypt private key\n",
      );
    await expect(
      normalizeImportedPrivateKey(pastedKey, `${"ñ".repeat(511)}a`),
    ).rejects.toMatchObject({ code: "SSH_KEY_PASSPHRASE_INVALID" });
    expect(state.spawned).toHaveLength(1);
    state.spawned.length = 0;
    // 512 two-byte characters: 1024 bytes but only 512 characters.
    for (const passphrase of ["ñ".repeat(512), "a".repeat(1_024)]) {
      const error = await normalizeImportedPrivateKey(pastedKey, passphrase).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "SSH_KEY_PASSPHRASE_TOO_LONG" });
      expect((error as Error).message).not.toContain(passphrase);
    }
    expect(state.spawned).toHaveLength(0);
    expect(await tmpIsEmpty()).toBe(true);
  });

  it("tries the empty passphrase through argv when none is given", async () => {
    state.fake = (_args, callback) =>
      callback(
        Object.assign(new Error("Command failed"), { code: 255 }),
        "",
        "Failed to load key: incorrect passphrase supplied to decrypt private key\n",
      );
    await expect(normalizeImportedPrivateKey(pastedKey, undefined)).rejects.toMatchObject({
      code: "SSH_KEY_PASSPHRASE_REQUIRED",
    });
    expect(state.spawned[0]?.args.slice(0, 4)).toEqual(["-q", "-p", "-P", ""]);
    expect(state.spawned[0]?.env).toMatchObject({
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "force",
    });
    expect(await tmpIsEmpty()).toBe(true);
  });
});

describe("parseKeyscanOutput", () => {
  it("keeps valid supported keys, drops comments, bad lines and duplicates", () => {
    const ed = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const output = [
      "# 140.82.112.3:22 SSH-2.0-babeld",
      `140.82.112.3 ssh-ed25519 ${ed}`,
      `140.82.112.3 ssh-ed25519 ${ed}`,
      `140.82.112.3 ssh-rsa ${ed}`,
      "140.82.112.3 ssh-dss AAAAB3NzaC1kc3M=",
      "garbage",
    ].join("\n");
    expect(parseKeyscanOutput(output)).toEqual([
      {
        keyType: "ssh-ed25519",
        publicKey: ed,
        fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
      },
    ]);
  });
});

it("closes the in-memory passphrase server and removes the key if socket permission setup fails", async () => {
  state.failSocketChmod = true;
  const input = `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nAAAA\n${OPENSSH_PRIVATE_KEY_ARMOR.end}`;
  await expect(normalizeImportedPrivateKey(input, "phrase-sentinel")).rejects.toThrow(
    "permission failure",
  );
  expect(state.closedSockets).toBe(1);
  expect(await tmpIsEmpty()).toBe(true);
  expect(state.spawned).toHaveLength(0);
});
