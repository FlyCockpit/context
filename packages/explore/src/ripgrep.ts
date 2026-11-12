import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  BINARY_EXTENSIONS,
  clampMaxMatches,
  clipMatchText,
  compileGrepPattern,
  exploreGrepJs,
  GREP_TIMEOUT_MS,
  type GrepMatch,
  type GrepOptions,
  type GrepResult,
  MAX_FILE_BYTES,
} from "./fs-ops";
import { GrepTimeoutError } from "./grep-worker";
import {
  GIT_METADATA_NAME,
  isGitMetadataPath,
  resolveWithinRoot,
  SKIP_DIR_NAMES,
  toRelativeRootPath,
} from "./paths";

/**
 * Which grep implementation to use:
 * - `"auto"` (default) — `rg` from PATH when present, otherwise the JavaScript walk;
 * - `false` — always the JavaScript walk;
 * - a path — that ripgrep binary (tests, or an image that installs it off PATH).
 */
export type RipgrepSetting = "auto" | false | string;

/** Cap on buffered stderr, which is only used for the fallback decision. */
const STDERR_CAP = 8_192;

let cachedPathLookup: string | null | undefined;

/** Locate `rg` on PATH once per process (no shell, no `which`). */
export function findRipgrepOnPath(): string | null {
  if (cachedPathLookup !== undefined) return cachedPathLookup;
  cachedPathLookup = null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "rg");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        cachedPathLookup = candidate;
        break;
      }
    } catch {
      // not here
    }
  }
  return cachedPathLookup;
}

function resolveRipgrep(setting: RipgrepSetting): string | null {
  if (setting === false) return null;
  if (setting === "auto") return findRipgrepOnPath();
  return setting;
}

/**
 * Regex content search under `root`: ripgrep when available, the JavaScript
 * walk otherwise, with the same result shape, order and caps either way.
 *
 * The pattern contract is a JavaScript RegExp (what the tool tells the model),
 * so it is compiled as one first — an invalid pattern fails identically on both
 * paths. A pattern that is valid JavaScript but not valid Rust regex (lookaround,
 * backreferences) makes ripgrep exit 2 with nothing printed, and the call falls
 * back to the JavaScript walk rather than failing. Both backends run off the
 * main thread (a child process, a worker thread) under one shared time budget
 * (a fallback after ripgrep gets only what ripgrep left), so a catastrophically
 * backtracking pattern cannot freeze the app. A timeout with no matches is a
 * `GrepTimeoutError` on either backend; with matches, they come back `truncated`.
 */
export async function exploreGrep(
  root: string,
  pattern: string,
  options: GrepOptions & { ripgrep?: RipgrepSetting } = {},
): Promise<GrepResult> {
  compileGrepPattern(pattern, options.caseInsensitive);
  const timeoutMs = options.timeoutMs ?? GREP_TIMEOUT_MS;
  const startedAt = Date.now();
  const binary = resolveRipgrep(options.ripgrep ?? "auto");
  if (binary) {
    const result = await ripgrepSearch(binary, root, pattern, { ...options, timeoutMs });
    if (result) return result;
  }
  return exploreGrepJs(root, pattern, {
    ...options,
    timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
  });
}

/** ripgrep's argument list; exported for the tests. */
export function ripgrepArgs(
  pattern: string,
  target: string,
  options: { caseInsensitive?: boolean; maxMatches: number },
): string[] {
  return [
    "--json",
    "--no-config",
    "--no-ignore",
    "--hidden",
    "--sort",
    "path",
    "--max-filesize",
    String(MAX_FILE_BYTES),
    "--max-count",
    String(options.maxMatches),
    ...[...SKIP_DIR_NAMES].flatMap((name) => ["--glob", `!${name}/`]),
    // No trailing slash: also the `.git` FILE of a linked worktree, which names a host path.
    "--glob",
    `!${GIT_METADATA_NAME}`,
    ...BINARY_EXTENSIONS.flatMap((ext) => ["--iglob", `!*${ext}`]),
    ...(options.caseInsensitive ? ["--ignore-case"] : []),
    "--regexp",
    pattern,
    "--",
    target,
  ];
}

type RipgrepText = { text?: string; bytes?: string };

function decodeRipgrepText(value: RipgrepText | undefined): string | null {
  if (!value) return null;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  return null;
}

/**
 * Parse one `rg --json` line into a match relative to the explore root, or
 * `null` for every other event type (begin/end/summary/context).
 */
export function parseRipgrepMatch(
  line: string,
): (Omit<GrepMatch, "path"> & { rawPath: string }) | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { type, data } = event as {
    type?: string;
    data?: { path?: RipgrepText; lines?: RipgrepText; line_number?: number };
  };
  if (type !== "match" || !data) return null;
  const rawPath = decodeRipgrepText(data.path);
  const text = decodeRipgrepText(data.lines);
  if (rawPath === null || text === null || typeof data.line_number !== "number") return null;
  return {
    rawPath,
    line: data.line_number,
    text: clipMatchText(text.replace(/\r?\n$/, "")),
  };
}

/**
 * Run ripgrep with `cwd` = the real root and a root-relative target, so the
 * paths it prints are already root-relative. Resolves `null` when ripgrep could
 * not answer (spawn failure, or an error exit with no matches) so the caller
 * falls back to the JavaScript walk; rejects with `GrepTimeoutError` when the
 * budget ran out before any match.
 */
function ripgrepSearch(
  binary: string,
  root: string,
  pattern: string,
  options: GrepOptions & { timeoutMs: number },
): Promise<GrepResult | null> {
  const maxMatches = clampMaxMatches(options.maxMatches);
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const base = resolveWithinRoot(root, options.searchPath ?? ".");
  // ripgrep searches a path named on its command line whatever the globs say.
  if (isGitMetadataPath(rootReal, base)) return Promise.resolve({ matches: [], truncated: false });
  const target = toRelativeRootPath(rootReal, base);

  return new Promise((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";

    // Minimal environment: no RIPGREP_CONFIG_PATH, no secrets.
    const child = spawn(binary, ripgrepArgs(pattern, target, { ...options, maxMatches }), {
      cwd: rootReal,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const timer = setTimeout(() => {
      truncated = true;
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();

    const finish = (result: GrepResult | null | GrepTimeoutError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof GrepTimeoutError) reject(result);
      else resolve(result);
    };

    const consume = (line: string) => {
      if (truncated || !line) return;
      const match = parseRipgrepMatch(line);
      if (!match) return;
      const relative = match.rawPath.replace(/^\.\//, "");
      matches.push({ path: relative === "" ? "." : relative, line: match.line, text: match.text });
      if (matches.length >= maxMatches) {
        truncated = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        consume(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk;
    });
    child.on("error", () => {
      // An abort keeps whatever arrived (the loop is abandoning the call anyway;
      // a fallback walk would only burn CPU). A spawn failure (ENOENT, EACCES)
      // with nothing printed means "fall back to the JavaScript walk".
      if (options.signal?.aborted || matches.length > 0) {
        finish({ matches, truncated: true });
        return;
      }
      finish(null);
    });
    child.on("close", (code) => {
      consume(stdoutBuffer);
      stdoutBuffer = "";
      // Same signal as the JavaScript backend: the model should change the pattern.
      if (timedOut && matches.length === 0 && !options.signal?.aborted) {
        return finish(new GrepTimeoutError(options.timeoutMs));
      }
      if (truncated) return finish({ matches, truncated: true });
      // 0 = matches, 1 = no matches, 2 = error (possibly after some matches,
      // e.g. one unreadable file — those matches stand).
      if (code === 0 || code === 1) return finish({ matches, truncated: false });
      if (matches.length > 0) return finish({ matches, truncated: false });
      return finish(null);
    });
  });
}
