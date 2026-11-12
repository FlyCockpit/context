import { spawn } from "node:child_process";

import { RepoError } from "./errors";

/**
 * The one way Cockpit Context runs git (docs/product.md). Repositories are attacker-controlled input, so every call:
 *
 * - is `spawn` with an argv array (no shell);
 * - prepends the hardening `-c` options below, which git also forwards to the
 *   child git processes it spawns (lazy blob fetches during a worktree add);
 * - without a pinned network config, also denies the https and ssh transports,
 *   so a local call can never make git lazily fetch from the promisor remote
 *   and resolve the host itself (outside the connect-time address check);
 * - runs with a minimal environment: the server's own env (DATABASE_URL, API
 *   keys) never reaches git or ssh, and user/system git config is ignored;
 * - runs in its own process group with a timeout and stdout/stderr caps; a
 *   timeout, abort or cap kills the whole group (SIGKILL), so helpers git
 *   started (git-remote-https, ssh, index-pack, a lazy fetch) die with it;
 * - names its repository with `--git-dir`, never by discovery — in development
 *   the data dir sits inside the Cockpit Context checkout, and a broken bare repo must not
 *   make git fall back to the enclosing repository.
 */

export const GIT_HARDENING_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "protocol.ssh.allow=always",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "core.symlinks=true",
  "core.fsmonitor=false",
  // Never let a remote redirect us to a host the address check did not see.
  "http.followRedirects=false",
  // Empty value resets the helper list: no credential prompts or stores.
  "credential.helper=",
  // Only explicitly named bare repositories (--git-dir) are ever used.
  "safe.bareRepository=explicit",
  // No detached background gc/maintenance outliving the call.
  "gc.auto=0",
  "maintenance.auto=false",
  "advice.detachedHead=false",
];

/**
 * Appended (last value wins) to every call without a `network` option. git
 * hands `-c` options to the git processes it spawns (GIT_CONFIG_PARAMETERS),
 * so a lazy fetch from the promisor remote fails closed instead of reaching
 * the network without the pinned address. Commits that exist only on the
 * server are fetched explicitly, through the pinned path.
 */
export const GIT_NO_NETWORK_CONFIG: readonly string[] = [
  "protocol.https.allow=never",
  "protocol.ssh.allow=never",
];

/** Network settings for one connect: pinned address, SSH command, known hosts. */
export interface GitNetwork {
  /** Extra `-c` options (e.g. `http.curloptResolve`). */
  config: readonly string[];
  /** Extra environment (e.g. `GIT_SSH_COMMAND`). */
  env: Readonly<Record<string, string>>;
}

export interface RunGitOptions {
  /** Bare repository to operate on (`--git-dir`). */
  gitDir?: string;
  /** Working directory (clone targets); defaults to the process cwd. */
  cwd?: string;
  network?: GitNetwork;
  timeoutMs?: number;
  /** Cap per stream; exceeding it kills git and fails the call. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * Non-zero exit codes the caller inspects itself: the call resolves with
   * the full output and `exitCode` instead of rejecting.
   */
  okExitCodes?: readonly number[];
}

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 0, or one of `okExitCodes`. */
  exitCode: number;
}

const LOCAL_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_IN_ERROR = 1_500;

/** A non-zero git exit, carrying the exit code and the (truncated) stderr. */
export class GitCommandError extends RepoError {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    code: "GIT_FAILED" | "GIT_TIMEOUT",
    message: string,
    exitCode: number | null,
    stderr: string,
  ) {
    super(code, message);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The environment git runs with. Nothing is inherited except PATH. */
export function gitEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // Without a network config, any attempt to reach a remote fails closed.
    GIT_SSH_COMMAND: "false",
    ...extra,
  };
}

/**
 * The full argv: hardening config, then the network config (or, without one,
 * the transport denial), --git-dir, then the command.
 */
export function gitArgv(args: readonly string[], options: RunGitOptions = {}): string[] {
  const argv: string[] = [];
  const extra = options.network ? options.network.config : GIT_NO_NETWORK_CONFIG;
  for (const entry of [...GIT_HARDENING_CONFIG, ...extra]) {
    argv.push("-c", entry);
  }
  if (options.gitDir) argv.push(`--git-dir=${options.gitDir}`);
  argv.push(...args);
  return argv;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_STDERR_IN_ERROR
    ? `${trimmed.slice(0, MAX_STDERR_IN_ERROR)}…`
    : trimmed;
}

function subcommandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "git";
}

/**
 * The error for a git that exited `exitCode` (null: killed by a signal it was
 * not sent by us) with `stderr`. Exported for callers that accept an exit code
 * through `okExitCodes` and then decide it was a failure after all.
 */
export function gitFailure(
  args: readonly string[],
  exitCode: number | null,
  stderr: string,
  options: RunGitOptions = {},
  fallbackDetail?: string,
): GitCommandError {
  const detail =
    truncate(stderr) || fallbackDetail || `Command failed: git ${gitArgv(args, options).join(" ")}`;
  return new GitCommandError(
    "GIT_FAILED",
    `git ${subcommandOf(args)} failed: ${detail}`,
    exitCode,
    truncate(stderr),
  );
}

/** SIGKILL every process in the group led by `pid`; a group already gone (ESRCH) is fine. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: nothing is left in the group. Never throw from an event handler.
  }
}

type KillReason = "timeout" | "abort" | "output";

/** Run git once. Resolves on exit 0; rejects with GitCommandError otherwise. */
export function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
  const argv = gitArgv(args, options);
  const timeout = options.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const subcommand = subcommandOf(args);
  const aborted = () =>
    new GitCommandError("GIT_FAILED", `git ${subcommand} was aborted.`, null, "");
  if (options.signal?.aborted) return Promise.reject(aborted());

  return new Promise((resolve, reject) => {
    // Own process group (detached): a kill reaches every helper git started.
    const child = spawn("git", argv, {
      cwd: options.cwd,
      env: gitEnvironment(options.network?.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killReason: KillReason | null = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    // Node sets exitCode/signalCode as it reaps git, before 'exit'. From then
    // on git's pid may be recycled, as the leader of some other detached
    // group, so -pid must not be signalled again: the 'exit' sweep below was
    // the last group kill.
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const kill = (reason: KillReason) => {
      if (killReason) return;
      killReason = reason;
      // Like execFile: drop the pipes first so a killed git never "succeeds"
      // with truncated output, and so a straggler holding them cannot delay us.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!exited()) killGroup(child.pid);
    };
    const onAbort = () => kill("abort");
    const timer = setTimeout(() => kill("timeout"), timeout);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (chunks: Buffer[]) => {
      let bytes = 0;
      return (chunk: Buffer) => {
        if (killReason) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          kill("output");
          return;
        }
        chunks.push(chunk);
      };
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    // Keep stdin open (like execFile): git never waits on it except by design.
    child.stdin?.on("error", () => {});

    child.on("error", (error) => {
      if (!exited()) killGroup(child.pid);
      settle(() =>
        reject(
          gitFailure(args, null, Buffer.concat(stderr).toString("utf8"), options, error.message),
        ),
      );
    });
    // git itself is gone: anything left in its group is an orphan helper.
    // Safe although git was just reaped: while any orphan is left, the kernel
    // keeps the pid allocated as that group's id, so -pid names exactly
    // them; with none left it is ESRCH. Reuse would need a full pid
    // wrap-around between the reap and this callback, which run back to back
    // in one event-loop turn. Later kills (`kill`, 'error') are skipped.
    child.on("exit", () => killGroup(child.pid));
    child.on("close", (code) => {
      const err = Buffer.concat(stderr).toString("utf8");
      settle(() => {
        if (killReason === "abort") {
          reject(aborted());
          return;
        }
        if (killReason === "timeout") {
          reject(
            new GitCommandError(
              "GIT_TIMEOUT",
              `git ${subcommand} timed out after ${Math.round(timeout / 1000)}s.`,
              null,
              truncate(err),
            ),
          );
          return;
        }
        if (killReason === "output") {
          reject(
            new GitCommandError(
              "GIT_FAILED",
              `git ${subcommand} produced more output than allowed.`,
              null,
              "",
            ),
          );
          return;
        }
        if (code === 0 || (code !== null && options.okExitCodes?.includes(code))) {
          resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: err, exitCode: code });
          return;
        }
        reject(gitFailure(args, code, err, options));
      });
    });
  });
}

/** `git rev-parse --verify` that returns null instead of throwing on a miss. */
export async function revParseCommit(gitDir: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
      { gitDir },
    );
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (error) {
    if (error instanceof GitCommandError && error.code === "GIT_FAILED") return null;
    throw error;
  }
}
