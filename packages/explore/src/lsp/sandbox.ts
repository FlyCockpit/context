import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LanguageServerCommand } from "./specs";

/**
 * COCKPIT_CONTEXT_LSP_SANDBOX. `required` (the default) runs every language server under
 * the Landlock helper (`tools/landlock/cockpit-context-landlock.c`) and disables the LSP
 * tools when the helper is missing or the kernel cannot enforce Landlock.
 * `off` runs them directly (development hosts only).
 */
export type LspSandboxMode = "required" | "off";

/**
 * Where the production image installs the helper (Dockerfile, `landlock-build`
 * stage): root-owned, 0755, outside anything the app user can write.
 */
export const LANDLOCK_HELPER_IMAGE_PATH =
  "/usr/local/libexec/cockpit-context/cockpit-context-landlock";
/** Where `pnpm run lsp:build-sandbox` (scripts/build-landlock-helper.mjs) puts it in a Cockpit Context checkout. */
export const LANDLOCK_HELPER_DEV_PATH = "tools/landlock/build/cockpit-context-landlock";

const PROBE_TIMEOUT_MS = 15_000;
/** Output kept from one helper run (its JSON or its first error line is all the probe reads). */
const PROBE_OUTPUT_CAP = 64 * 1024;

/**
 * Waits before probing again after a `failed` probe: 30 s, 2 min, 10 min, then
 * every 10 min (the last entry repeats). `missing` and `unsupported` are not
 * retried: installing the helper or changing the kernel means a restart anyway.
 */
const PROBE_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** A process to spawn: what `LspClient` runs. */
export type LspLaunch = {
  command: string;
  args: string[];
  /** The complete child env. */
  env: Record<string, string>;
  cwd: string;
  /** Removes the launch's private directory; `LspClient` calls it when the process is gone. */
  cleanup: () => void;
};

export type LspLaunchRequest = {
  server: LanguageServerCommand;
  /** Absolute real path of the checkout. */
  checkoutRoot: string;
  /** Absolute real path of the server's workspace root (the checkout or a subdirectory). */
  workspaceRoot: string;
};

/** What the kernel's Landlock offers here (the helper's `--probe`). */
type LandlockProtections = {
  /** Landlock ABI version (1 = Linux 5.13). */
  abi: number;
  /** Outbound TCP connect and TCP bind denied (ABI 4, Linux 6.7). */
  tcp: boolean;
  /** Signals and abstract Unix sockets scoped to the sandbox (ABI 6, Linux 6.12). */
  scoping: boolean;
};

export type LspSandboxStatus =
  | ({
      mode: "landlock";
      /** When the probe that passed finished (ISO 8601). */
      checkedAt: string;
    } & LandlockProtections)
  | { mode: "off" }
  | {
      /** The first probe is still running: the LSP tools stay off until it passes. */
      mode: "probing";
      /** When it started (ISO 8601). */
      since: string;
      /** Last completed probe, when this is a retry. */
      checkedAt?: string;
    }
  | {
      mode: "unavailable";
      /**
       * `missing`: no helper binary. `unsupported`: the kernel has no usable
       * Landlock. `failed`: the helper ran but could not sandbox a test server
       * (probed again on a backoff, `retryAt`).
       */
      reason: "missing" | "unsupported" | "failed";
      /** The helper's own message (operator logs and the admin screen only). */
      detail: string;
      /** When the last probe finished (ISO 8601). */
      checkedAt: string;
      /** `failed` only: when the next probe is scheduled (ISO 8601). */
      retryAt?: string;
    };

export interface LspSandbox {
  /**
   * The current state, without blocking: the first call (required mode)
   * starts the asynchronous probe and returns `probing` until it settles.
   * `landlock`, `missing` and `unsupported` are cached; `failed` is probed
   * again on a backoff (PROBE_RETRY_DELAYS_MS). Each outcome is logged.
   */
  status(): LspSandboxStatus;
  /** Starts the probe if needed and resolves once it (or a running retry) settles. */
  ready(): Promise<LspSandboxStatus>;
  /** A fresh launch with its own private directory. Throws when the sandbox is unavailable. */
  launch(request: LspLaunchRequest): LspLaunch;
  /** Removes every private directory still present. */
  dispose(): void;
}

const isUnder = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

const realOrNull = (file: string): string | undefined => {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
};

/**
 * The system directories every server reads and executes from: /usr, and the
 * top-level library directories when they are real directories (on merged-/usr
 * systems they are links into /usr and need no rule of their own).
 */
function systemRules(): string[] {
  const args = ["--rx", "/usr"];
  for (const dir of ["/lib", "/lib32", "/lib64", "/libx32"]) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isSymbolicLink() && stat.isDirectory()) args.push("--rx", dir);
    } catch {
      // Absent here.
    }
  }
  // The dynamic loader's cache: not secret, and it spares the loader a search.
  if (fs.existsSync("/etc/ld.so.cache")) args.push("--ro", "/etc/ld.so.cache");
  return args;
}

/** The env every server gets (sandboxed or not), plus the spec's own variables. */
function serverEnv(server: LanguageServerCommand, privateDir: string): Record<string, string> {
  return {
    // Never empty: an empty PATH makes execvp search the cwd (the checkout).
    // An empty private directory: no `npm`, no `python` (and, sandboxed, it
    // is writable but never executable).
    PATH: path.join(privateDir, "bin"),
    HOME: path.join(privateDir, "home"),
    TMPDIR: path.join(privateDir, "tmp"),
    LANG: "C.UTF-8",
    // Node's OpenSSL reads /etc/ssl/openssl.cnf at startup and treats a
    // denied read as fatal: an empty config of our own instead of opening /etc/ssl.
    OPENSSL_CONF: path.join(privateDir, "openssl.cnf"),
    ...server.env,
  };
}

/**
 * A new `cockpit-context-lsp-*` directory (0700) with `bin`, `home`, `tmp` and an empty
 * `openssl.cnf`, outside every checkout.
 */
export function createPrivateDir(parent = os.tmpdir()): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, "cockpit-context-lsp-")));
  for (const sub of ["bin", "home", "tmp"]) fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "openssl.cnf"), "", { mode: 0o600 });
  return dir;
}

/**
 * The helper's command line for one server. Pure apart from `realpath`/`lstat`
 * of the paths it names.
 *
 * Read and execute: /usr (and real /lib* directories), the server's command.
 * Read only: `/etc/ld.so.cache`, the server's own files
 * (`server.readOnlyPaths`) and the ONE checkout. Read and write (never
 * execute): the launch's private directory (HOME, TMPDIR and the empty PATH
 * directory). Nothing else: no other checkout, bare clone or key file under
 * the data dir, no app source or dist, no /proc, /home, /root, and no /etc
 * beyond the loader cache. The env is exactly `env`; the helper drops the rest.
 *
 * Throws when an allowed path would expose more than the checkout (a server
 * path that contains the checkout, which would also contain its siblings).
 */
export function buildLandlockArgs(
  request: LspLaunchRequest,
  privateDir: string,
  env: Record<string, string>,
): string[] {
  const { server, checkoutRoot, workspaceRoot } = request;
  if (!path.isAbsolute(checkoutRoot) || !isUnder(workspaceRoot, checkoutRoot)) {
    throw new Error("the workspace root must be inside the checkout");
  }
  const command = fs.realpathSync(server.command);
  const args = systemRules();
  const covered = (target: string) =>
    isUnder(target, "/usr") ||
    args.some((arg, i) => args[i - 1] === "--rx" && isUnder(target, arg));
  // A data dir under /usr (or a real /lib*) would make every sibling checkout
  // readable through the system rule.
  if (covered(checkoutRoot) || covered(privateDir)) {
    throw new Error("the checkout and the private directory must not be under a system directory");
  }
  const allow = (flag: "--ro" | "--rx", target: string) => {
    if (isUnder(checkoutRoot, target) || isUnder(privateDir, target)) {
      throw new Error("a language-server path contains the checkout or the private directory");
    }
    if (!covered(target)) args.push(flag, target);
  };
  allow("--rx", command);
  for (const candidate of server.readOnlyPaths ?? []) {
    const real = realOrNull(candidate);
    if (real) allow("--ro", real);
  }
  args.push("--ro", checkoutRoot, "--rw", privateDir);
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push("--chdir", workspaceRoot, "--", command, ...server.args);
  return args;
}

export type ProbeResult =
  | ({ ok: true } & LandlockProtections)
  | { ok: false; reason: "missing" | "unsupported" | "failed"; detail: string };

type HelperProbe = {
  landlock?: boolean;
  abi?: number;
  tcp?: boolean;
  scoping?: boolean;
  enforced?: boolean;
  reason?: string;
};

const firstLine = (text: string | undefined) => (text ?? "").trim().split("\n")[0]?.slice(0, 500);

/**
 * The script the startup probe runs inside the sandbox: it must read the
 * checkout's file and must NOT read the sibling's.
 */
const PROBE_SCRIPT = `
const fs = require("node:fs");
const [inside, outside] = process.argv.slice(1);
try { fs.readFileSync(inside); } catch (error) { console.error("cannot read the checkout: " + error.code); process.exit(3); }
try { fs.readFileSync(outside); console.error("read a file outside the checkout"); process.exit(4); } catch {}
`;

type HelperRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn error (ENOENT: no helper) or the timeout. */
  error?: NodeJS.ErrnoException;
};

/**
 * Runs the helper asynchronously with an empty env, no stdin, a hard
 * timeout (SIGKILL) and capped output, so a probe never blocks the event loop.
 */
function runHelper(command: string, args: string[]): Promise<HelperRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (run: Omit<HelperRun, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, stdout, stderr });
    };
    const child = spawn(command, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, PROBE_OUTPUT_CAP);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, PROBE_OUTPUT_CAP);
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ status: null, error }));
    child.on("close", (code) =>
      finish(
        timedOut
          ? {
              status: code,
              error: new Error(`the helper did not finish within ${PROBE_TIMEOUT_MS / 1000} s`),
            }
          : { status: code },
      ),
    );
  });
}

/**
 * Whether `helper` can sandbox a server here. Runs `helper --probe` (the ABI,
 * and a restriction the kernel actually enforces), then Node inside exactly
 * the layout a server gets, against a temporary checkout with a sibling file:
 * the checkout must be readable and the sibling must not be. Asynchronous,
 * each run bounded by a 15 s timeout.
 */
export async function probeLandlock(helper: string): Promise<ProbeResult> {
  const probe = await runHelper(helper, ["--probe"]);
  if (probe.error) {
    return probe.error.code === "ENOENT"
      ? { ok: false, reason: "missing", detail: `the Landlock helper is not installed (${helper})` }
      : { ok: false, reason: "failed", detail: probe.error.message };
  }
  let parsed: HelperProbe;
  try {
    parsed = JSON.parse(probe.stdout) as HelperProbe;
  } catch {
    return {
      ok: false,
      reason: "failed",
      detail:
        firstLine(probe.stderr) || `the helper's --probe printed no result (exit ${probe.status})`,
    };
  }
  if (!parsed.abi) {
    return {
      ok: false,
      reason: "unsupported",
      detail: parsed.reason ?? "this kernel offers no Landlock",
    };
  }
  // A valid ABI proves kernel support even when the helper's self-test fails
  // (for example, fork() can fail with EAGAIN). Retry instead of caching it.
  if (!parsed.landlock || !parsed.enforced || probe.status !== 0) {
    return {
      ok: false,
      reason: "failed",
      detail: parsed.reason ?? "the restriction was not enforced",
    };
  }

  const base = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-context-lsp-probe-")),
  );
  try {
    const checkout = path.join(base, "checkout");
    const outside = path.join(base, "outside");
    await fsp.mkdir(checkout);
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(checkout, "inside.txt"), "inside\n");
    await fsp.writeFile(path.join(outside, "outside.txt"), "outside\n");
    const privateDir = createPrivateDir(base);
    const server: LanguageServerCommand = {
      command: process.execPath,
      args: [
        "-e",
        PROBE_SCRIPT,
        path.join(checkout, "inside.txt"),
        path.join(outside, "outside.txt"),
      ],
    };
    const args = buildLandlockArgs(
      { server, checkoutRoot: checkout, workspaceRoot: checkout },
      privateDir,
      serverEnv(server, privateDir),
    );
    const run = await runHelper(helper, args);
    if (run.error) return { ok: false, reason: "failed", detail: run.error.message };
    if (run.status !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: firstLine(run.stderr) || `the test server exited with status ${run.status}`,
      };
    }
    return {
      ok: true,
      abi: parsed.abi,
      tcp: Boolean(parsed.tcp),
      scoping: Boolean(parsed.scoping),
    };
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

/**
 * The helper: the image's fixed path, else (outside production) the build of
 * `pnpm run lsp:build-sandbox` in the Cockpit Context checkout this module runs from.
 * Undefined when neither exists.
 */
export function findLandlockHelper(
  options: { production?: boolean; from?: string } = {},
): string | undefined {
  const executable = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (executable(LANDLOCK_HELPER_IMAGE_PATH)) return LANDLOCK_HELPER_IMAGE_PATH;
  if (options.production ?? process.env.NODE_ENV === "production") return undefined;
  let dir = options.from ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, LANDLOCK_HELPER_DEV_PATH);
    if (executable(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export type CreateLspSandboxOptions = {
  mode: LspSandboxMode;
  /** The helper binary (default: `findLandlockHelper()`). */
  helperPath?: string;
  /**
   * Replaces `probeLandlock` (tests). A plain (non-promise) result settles the
   * status synchronously.
   */
  probe?: () => ProbeResult | Promise<ProbeResult>;
  /** Parent of the private directories (default: the OS temp dir). */
  tempDir?: string;
  logger?: Pick<Console, "warn" | "error">;
};

/** Private directories of live launches, removed on cleanup or dispose. */
function privateDirs(tempDir: string | undefined) {
  const live = new Set<string>();
  return {
    create(): { dir: string; cleanup: () => void } {
      const dir = createPrivateDir(tempDir);
      live.add(dir);
      return {
        dir,
        cleanup: () => {
          live.delete(dir);
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    dispose() {
      for (const dir of live) fs.rmSync(dir, { recursive: true, force: true });
      live.clear();
    },
  };
}

/**
 * The sandbox policy for one `LspManager`. `required` never falls back to an
 * unsandboxed server: a missing helper or a kernel without Landlock makes
 * `status()` `unavailable`, and the manager then offers no LSP tools.
 */
export function createLspSandbox(options: CreateLspSandboxOptions): LspSandbox {
  const logger = options.logger ?? console;
  return options.mode === "off" ? offSandbox(options, logger) : landlockSandbox(options, logger);
}

function landlockSandbox(
  options: CreateLspSandboxOptions,
  logger: Pick<Console, "warn" | "error">,
): LspSandbox {
  const helper = options.helperPath ?? findLandlockHelper();
  const probe =
    options.probe ??
    ((): ProbeResult | Promise<ProbeResult> =>
      helper
        ? probeLandlock(helper)
        : {
            ok: false,
            reason: "missing",
            detail: `the Landlock helper (cockpit-context-landlock) is not installed: expected ${LANDLOCK_HELPER_IMAGE_PATH}, or ${LANDLOCK_HELPER_DEV_PATH} in development (pnpm run lsp:build-sandbox)`,
          });
  const retryDelays = PROBE_RETRY_DELAYS_MS;
  const dirs = privateDirs(options.tempDir);
  let current: LspSandboxStatus | undefined;
  let probingSince: string | undefined;
  let inFlight: Promise<LspSandboxStatus> | undefined;
  let failedAttempts = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const settle = (result: ProbeResult): LspSandboxStatus => {
    const checkedAt = new Date().toISOString();
    if (result.ok) {
      if (failedAttempts > 0) {
        logger.warn(
          `[lsp] the Landlock sandbox probe passed after ${failedAttempts} failed attempt${failedAttempts === 1 ? "" : "s"}; the LSP tools are enabled.`,
        );
      }
      failedAttempts = 0;
      current = {
        mode: "landlock",
        abi: result.abi,
        tcp: result.tcp,
        scoping: result.scoping,
        checkedAt,
      };
      return current;
    }
    const prefix = `[lsp] COCKPIT_CONTEXT_LSP_SANDBOX=required but the Landlock sandbox is unavailable (${result.detail}); the LSP tools are disabled.`;
    if (result.reason !== "failed" || disposed) {
      current = { mode: "unavailable", reason: result.reason, detail: result.detail, checkedAt };
      logger.error(`${prefix} See docs/deploy.md.`);
      return current;
    }
    // A failed probe can be transient (a loaded host, a slow disk): try again
    // on a backoff instead of leaving the tools off until a restart.
    const delay = retryDelays[Math.min(failedAttempts, retryDelays.length - 1)] ?? 600_000;
    failedAttempts += 1;
    current = {
      mode: "unavailable",
      reason: "failed",
      detail: result.detail,
      checkedAt,
      retryAt: new Date(Date.now() + delay).toISOString(),
    };
    logger.error(`${prefix} Probing again in ${formatDelay(delay)}. See docs/deploy.md.`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void runProbe();
    }, delay);
    retryTimer.unref?.();
    return current;
  };

  const runProbe = (): Promise<LspSandboxStatus> => {
    if (inFlight) return inFlight;
    if (disposed && current) return Promise.resolve(current);
    probingSince = new Date().toISOString();
    const checkedAt = current && "checkedAt" in current ? current.checkedAt : undefined;
    current = { mode: "probing", since: probingSince, ...(checkedAt ? { checkedAt } : {}) };
    let outcome: ProbeResult | Promise<ProbeResult>;
    try {
      outcome = probe();
    } catch (error) {
      outcome = { ok: false, reason: "failed", detail: errorMessage(error) };
    }
    if (!(outcome instanceof Promise)) return Promise.resolve(settle(outcome));
    const pending = outcome
      .catch(
        (error: unknown): ProbeResult => ({
          ok: false,
          reason: "failed",
          detail: errorMessage(error),
        }),
      )
      .then(settle)
      .finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    inFlight = pending;
    return pending;
  };

  const status = (): LspSandboxStatus => {
    if (!current && !inFlight) void runProbe();
    return current ?? { mode: "probing", since: probingSince ?? new Date().toISOString() };
  };
  return {
    status,
    ready: () => inFlight ?? (current ? Promise.resolve(current) : runProbe()),
    launch(request) {
      if (status().mode !== "landlock" || !helper) {
        throw new Error("the language-server sandbox is unavailable");
      }
      const { dir, cleanup } = dirs.create();
      try {
        return {
          command: helper,
          args: buildLandlockArgs(request, dir, serverEnv(request.server, dir)),
          // The helper gets no env of its own; the server's env is in its arguments.
          env: {},
          cwd: "/",
          cleanup,
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      dirs.dispose();
    },
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const formatDelay = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

/**
 * No sandbox (`COCKPIT_CONTEXT_LSP_SANDBOX=off`): the server runs directly, with the same
 * minimal env and private directory, `cwd` at its workspace root.
 */
function offSandbox(
  options: CreateLspSandboxOptions,
  logger: Pick<Console, "warn" | "error">,
): LspSandbox {
  logger.warn(
    "[lsp] COCKPIT_CONTEXT_LSP_SANDBOX=off: language servers run WITHOUT the Landlock sandbox, so a hostile repository config can make them read files outside the checkout. Use this on development hosts only.",
  );
  const dirs = privateDirs(options.tempDir);
  return {
    status: () => ({ mode: "off" }),
    ready: async () => ({ mode: "off" }),
    launch({ server, workspaceRoot }) {
      const { dir, cleanup } = dirs.create();
      return {
        command: server.command,
        args: server.args,
        env: serverEnv(server, dir),
        cwd: workspaceRoot,
        cleanup,
      };
    },
    dispose: () => dirs.dispose(),
  };
}
