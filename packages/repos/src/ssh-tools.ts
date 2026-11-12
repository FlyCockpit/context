import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { RepoError } from "./errors";
import {
  OPENSSH_PRIVATE_KEY_ARMOR,
  type PublicKey,
  parsePublicKey,
  parsePublicKeyLine,
} from "./openssh";
import { makeInvocationTmpDir, removeInsideDataDir } from "./paths";

/**
 * Thin wrappers over the OpenSSH client tools (`ssh-keygen`, `ssh-keyscan`),
 * shipped in the runtime image with `openssh-client`. Same rules as git: no
 * shell, minimal environment, timeouts, output caps.
 */

const MAX_PRIVATE_KEY_CHARS = 16 * 1024;
/**
 * OpenSSH's askpass reader (`ssh_askpass()` in readpass.c) keeps at most
 * 1023 bytes of the helper's output, so a longer passphrase would be tried
 * truncated. Measured in UTF-8 bytes, which is what the helper prints.
 */
export const MAX_PASSPHRASE_BYTES = 1023;
const TOOL_TIMEOUT_MS = 15_000;

type ToolResult = { stdout: string; stderr: string; exitCode: number | null };

/**
 * The askpass hand-off for one ssh-keygen call: the helper script's path.
 * OpenSSH >= 8.4 honours `SSH_ASKPASS_REQUIRE=force` without `DISPLAY`
 * (the runtime image ships 9.2; `scripts/check-runtime-tools.mjs` enforces
 * the floor).
 */
type Askpass = { helperPath: string; close: () => Promise<void> };

function toolEnv(askpass: Askpass | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    // Always force askpass, so no OpenSSH tool ever falls back to prompting
    // on /dev/tty; without a helper, /bin/false answers every prompt with "".
    SSH_ASKPASS: askpass?.helperPath ?? "/bin/false",
    SSH_ASKPASS_REQUIRE: "force",
  };
}

function runTool(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; askpass?: Askpass } = {},
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        env: toolEnv(options.askpass),
        timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`${file} is not installed (install openssh-client).`));
          return;
        }
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
    // Never let a tool wait on a terminal or stdin.
    child.stdin?.end();
  });
}

/** The helper reads a request-local Unix socket; passphrase bytes never touch a file or argv. */
const ASKPASS_SCRIPT = `#!/usr/bin/env node
const net = require("node:net");
const path = require("node:path");
const socket = net.connect(path.join(__dirname, "phrase.sock"));
socket.on("data", (data) => process.stdout.write(data));
socket.on("error", () => process.exit(1));
`;

async function writeAskpass(passphrase: string): Promise<Askpass> {
  // Unix socket paths are limited to roughly 107 bytes. Never inherit a
  // potentially long COCKPIT_CONTEXT_DATA_DIR path; mkdtemp creates a private 0700 dir.
  const dir = await mkdtemp(path.join(tmpdir(), "cockpit-context-ap-"));
  const server = createServer((socket) => socket.end(passphrase));
  const close = async () => {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(dir, "phrase.sock"), resolve);
    });
    await chmod(path.join(dir, "phrase.sock"), 0o600);
    const helperPath = path.join(dir, "askpass.cjs");
    await writeFile(helperPath, ASKPASS_SCRIPT, { mode: 0o700, flag: "wx" });
    await chmod(helperPath, 0o700);
    return { helperPath, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface NormalizedPrivateKey {
  /** Unencrypted `openssh-key-v1` private key text. */
  privateKey: string;
  publicKey: PublicKey;
}

/**
 * Validate a pasted private key (OpenSSH, PKCS#1/PKCS#8/SEC1 PEM, encrypted or
 * not) by letting `ssh-keygen` load it, strip its passphrase and rewrite it as
 * an unencrypted OpenSSH key, then derive the public key from the result.
 *
 * The key only touches disk inside a 0700 per-invocation directory under
 * COCKPIT_CONTEXT_DATA_DIR/tmp, as a 0600 file, removed in `finally` (and swept at boot
 * if the process dies mid-call). The passphrase never reaches a file, argv or
 * environment: a request-local Unix socket hands it to ssh-keygen through an SSH_ASKPASS helper script
 * (`SSH_ASKPASS_REQUIRE=force`, stdin closed, so ssh-keygen never prompts on
 * a terminal). Without a passphrase, `-P ""` tries the empty one.
 */
export async function normalizeImportedPrivateKey(
  text: string,
  passphrase: string | undefined,
): Promise<NormalizedPrivateKey> {
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PRIVATE_KEY_CHARS ||
    !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(trimmed)
  ) {
    throw new RepoError(
      "SSH_KEY_INVALID",
      "That does not look like an OpenSSH or PEM private key.",
    );
  }
  // OpenSSH cuts an askpass answer at the first CR or LF (and C strings at
  // NUL), and keeps at most 1023 bytes of it, so such a passphrase would be
  // tried truncated: refuse it outright, each with its own code.
  if (passphrase && /[\r\n\0]/.test(passphrase)) {
    throw new RepoError(
      "SSH_KEY_PASSPHRASE_LINE_BREAK",
      "Passphrases with line breaks are not supported.",
    );
  }
  if (passphrase && Buffer.byteLength(passphrase, "utf8") > MAX_PASSPHRASE_BYTES) {
    throw new RepoError(
      "SSH_KEY_PASSPHRASE_TOO_LONG",
      `Passphrases longer than ${MAX_PASSPHRASE_BYTES} bytes are not supported.`,
    );
  }
  const dir = await makeInvocationTmpDir();
  let askpass: Askpass | undefined;
  try {
    const keyPath = path.join(dir, "key");
    await writeFile(keyPath, `${trimmed}\n`, { mode: 0o600, flag: "wx" });
    askpass = passphrase ? await writeAskpass(passphrase) : undefined;
    // With a passphrase, ssh-keygen first tries the empty one, then asks the
    // helper once for the old passphrase; `-N ""` answers the new one.
    const rewrite = await runTool(
      "ssh-keygen",
      ["-q", "-p", ...(askpass ? [] : ["-P", ""]), "-N", "", "-f", keyPath],
      { askpass },
    );
    if (rewrite.exitCode !== 0) {
      if (askpass && /ssh_askpass/i.test(rewrite.stderr)) {
        // The helper could not run (for example the system temp mount is
        // noexec). Not the user's fault, so not a passphrase error.
        throw new Error(
          "ssh-keygen could not run its askpass helper in the system temporary directory (is the system temporary directory mounted noexec?).",
        );
      }
      if (/incorrect passphrase/i.test(rewrite.stderr)) {
        throw passphrase
          ? new RepoError("SSH_KEY_PASSPHRASE_INVALID", "The passphrase does not unlock this key.")
          : new RepoError(
              "SSH_KEY_PASSPHRASE_REQUIRED",
              "This key is passphrase-protected; enter its passphrase.",
            );
      }
      throw new RepoError("SSH_KEY_INVALID", "The private key could not be read.");
    }
    const derived = await runTool("ssh-keygen", ["-y", "-f", keyPath]);
    if (derived.exitCode !== 0) {
      throw new RepoError("SSH_KEY_INVALID", "The public key could not be derived from this key.");
    }
    const [keyType = ""] = derived.stdout.trim().split(/\s+/);
    const publicKey = parsePublicKeyLine(derived.stdout);
    if (!publicKey) {
      throw new RepoError("SSH_KEY_UNSUPPORTED", `Unsupported key type ${keyType || "unknown"}.`);
    }
    const privateKey = await readFile(keyPath, "utf8");
    if (!privateKey.startsWith(OPENSSH_PRIVATE_KEY_ARMOR.begin)) {
      throw new RepoError("SSH_KEY_INVALID", "The private key could not be converted.");
    }
    return { privateKey, publicKey };
  } finally {
    try {
      await askpass?.close();
    } finally {
      await removeInsideDataDir(dir);
    }
  }
}

/**
 * `ssh-keyscan` one already-validated address. Returns every supported key
 * the host offered, with fingerprints; never trusts the host name column of
 * the output.
 */
export async function keyscan(
  address: string,
  port: number,
  timeoutSeconds = 5,
): Promise<PublicKey[]> {
  const result = await runTool(
    "ssh-keyscan",
    ["-T", String(timeoutSeconds), "-p", String(port), "-t", "ed25519,ecdsa,rsa", "--", address],
    { timeoutMs: (timeoutSeconds + 5) * 1_000 },
  );
  return parseKeyscanOutput(result.stdout);
}

/** Parse `host keytype base64` lines; comments and invalid lines are dropped, duplicates merged. */
export function parseKeyscanOutput(output: string): PublicKey[] {
  const keys = new Map<string, PublicKey>();
  for (const line of output.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [, keyType = "", blob = ""] = line.trim().split(/\s+/);
    const key = parsePublicKey(keyType, blob);
    if (key) keys.set(key.fingerprint, key);
  }
  return [...keys.values()];
}
