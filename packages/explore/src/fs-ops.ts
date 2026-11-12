import fs from "node:fs";
import path from "node:path";

import { Minimatch } from "minimatch";

import { runGrepWorker } from "./grep-worker";
import {
  GIT_METADATA_NAME,
  gitMetadataNotFound,
  isGitMetadataPath,
  resolveWithinRoot,
  SKIP_DIR_NAMES,
  toRelativeRootPath,
} from "./paths";

const DEFAULT_MAX_MATCHES = 40;
export const MAX_GREP_MATCHES = 100;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
/** Files larger than this are never read or searched (ripgrep: `--max-filesize`). */
export const MAX_FILE_BYTES = 512_000;
const MAX_GLOB_RESULTS = 200;
/** Directory entries one glob may visit before it stops and reports `truncated`. */
const MAX_GLOB_VISITS = 50_000;
/** Wall-clock budget for one grep call, on either backend; the abort signal also stops it. */
export const GREP_TIMEOUT_MS = 15_000;
/** A grep match line longer than this is clipped with `…`. */
const MAX_MATCH_TEXT_CHARS = 400;
/** A single read line longer than this is clipped (minified bundles are one line). */
const MAX_READ_LINE_CHARS = 2_000;
/** Total characters of numbered content one read returns; whole lines past it page. */
const MAX_READ_CONTENT_CHARS = 24_000;

/** Extensions grep never opens (both the ripgrep and the JavaScript path). */
export const BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mp3",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
] as const;

export type GlobResult = {
  matches: string[];
  truncated: boolean;
};

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type GrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
};

export type GrepOptions = {
  searchPath?: string;
  caseInsensitive?: boolean;
  maxMatches?: number;
  /** Wall-clock budget for the call (default `GREP_TIMEOUT_MS`). */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ReadResult = {
  path: string;
  offset: number;
  limit: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  /** First line not returned, when `truncated`; pass it as the next `offset`. */
  nextOffset?: number;
};

/**
 * Glob under `root` (optionally under `searchPath`).
 *
 * The walk is our own `readdir` walk, never `fs.globSync`: it never descends
 * through a symbolic link (a checkout can plant `sub/rootlink -> /`, and a
 * glob that followed it would crawl the host filesystem synchronously before
 * the escaped matches could be dropped), symlinked files are not listed (as in
 * `grep`), and the walk is bounded by entries visited as well as by matches
 * kept. `searchPath` and the pattern's literal leading directories resolve like
 * `read` does — an in-root link there is followed, an escaping one is refused —
 * and the walk starts there. Wildcards follow `path.matchesGlob` (Node's glob
 * semantics: `*` and `**` skip dotfiles unless the pattern names the dot),
 * compiled once per call (`compileGlob`) rather than looked up per entry.
 *
 * The walk also prunes by the pattern's shape (`createDirFilter`): it only
 * enters a directory that can still hold a match, so the visit cap is spent
 * where matches can be — a large sibling directory never starves `tsconfig*.json`
 * or `src/*.ts` into a false empty result.
 *
 * Git metadata is never listed: an entry named `.git` (the directory, or a
 * linked worktree's `.git` file, which names a host path) is skipped, and a
 * `searchPath` or literal prefix inside one finds nothing, as a missing one does.
 *
 * Synchronous; the `glob` tool uses `exploreGlobAsync`, the same walk.
 */
export function exploreGlob(root: string, pattern: string, searchPath = "."): GlobResult {
  const walk = globWalk(root, pattern, searchPath, () => false);
  let step = walk.next();
  while (!step.done) step = walk.next(readDirSync(step.value));
  return step.value;
}

/**
 * `exploreGlob` with non-blocking directory reads, and an abort `signal`
 * checked before each directory. Like `grep`, an aborted call returns what it
 * matched so far as `truncated` (the loop is abandoning the call anyway).
 */
export async function exploreGlobAsync(
  root: string,
  pattern: string,
  searchPath = ".",
  options: { signal?: AbortSignal } = {},
): Promise<GlobResult> {
  const walk = globWalk(root, pattern, searchPath, () => options.signal?.aborted === true);
  let step = walk.next();
  while (!step.done) step = walk.next(await readDirAsync(step.value));
  return step.value;
}

function readDirSync(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function readDirAsync(dir: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * The glob walk, written once for both drivers: it yields each directory to
 * read and is resumed with its entries (`null` when it could not be read), so
 * the order, caps, filters and `truncated` are the same whichever reads them.
 */
function* globWalk(
  root: string,
  pattern: string,
  searchPath: string,
  stopped: () => boolean,
): Generator<string, GlobResult, fs.Dirent[] | null> {
  assertRelativeGlob(pattern);
  const segments = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return { matches: [], truncated: false };
  const normalized = segments.join("/");
  const firstMagic = segments.findIndex((segment) => GLOB_MAGIC.test(segment));
  const prefix = segments.slice(0, firstMagic === -1 ? segments.length - 1 : firstMagic);

  const base = resolveWithinRoot(root, searchPath);
  const rootReal = fs.realpathSync.native(path.resolve(root));
  if (isGitMetadataPath(rootReal, base)) return { matches: [], truncated: false };
  let start: string;
  try {
    start = resolveWithinRoot(rootReal, path.relative(rootReal, path.join(base, ...prefix)));
  } catch (error) {
    if (isNotFound(error)) return { matches: [], truncated: false };
    throw error;
  }
  if (isGitMetadataPath(rootReal, start)) return { matches: [], truncated: false };

  const matcher = compileGlob(normalized);
  const canHoldMatch = createDirFilter(segments);
  const matches: string[] = [];
  let truncated = false;
  let visited = 0;
  function* walk(
    current: string,
    relativeSegments: string[],
  ): Generator<string, boolean, fs.Dirent[] | null> {
    if (stopped()) {
      truncated = true;
      return false;
    }
    const listed = yield current;
    if (listed === null) return true;
    const entries = listed.sort(byName);
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_GLOB_VISITS) {
        truncated = true;
        return false;
      }
      if (entry.name === GIT_METADATA_NAME) continue;
      const relative = [...relativeSegments, entry.name];
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || !canHoldMatch(relative)) continue;
        if (!(yield* walk(path.join(current, entry.name), relative))) return false;
        continue;
      }
      // Symlinks (and sockets, FIFOs…) are neither listed nor followed.
      if (!entry.isFile()) continue;
      if (!matcher.match(relative.join("/"))) continue;
      // The walk never followed a link, so this is the real in-root path.
      matches.push(
        path.relative(rootReal, path.join(current, entry.name)).split(path.sep).join("/"),
      );
      if (matches.length >= MAX_GLOB_RESULTS) {
        truncated = true;
        return false;
      }
    }
    return true;
  }
  yield* walk(start, prefix);

  matches.sort();
  return { matches, truncated };
}

/**
 * `pattern` compiled with the options Node's `path.matchesGlob` passes to its
 * bundled minimatch (lib/internal/fs/glob.js `createMatcher`), so a compiled
 * matcher answers exactly as `path.matchesGlob(p, pattern)` would.
 */
function compileGlob(pattern: string): Minimatch {
  return new Minimatch(pattern, {
    nocase: process.platform === "win32" || process.platform === "darwin",
    windowsPathsNoEscape: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    platform: process.platform,
    nocaseMagicOnly: true,
  });
}

/** A segment with any of these is a wildcard segment (conservative: extglob and escapes too). */
const GLOB_MAGIC = /[*?[\]{}()!+@\\]/;

/**
 * From the pattern's segments, a test for whether a directory (its path
 * relative to the walk base, as segments) can still contain a match:
 *
 * - before the first `**` segment, the directory's path must match the
 *   pattern's leading segments one for one;
 * - with no `**`, the walk never goes deeper than the pattern (a file at depth
 *   n can only match an n-segment pattern);
 * - past a `**`, any directory can, except a dot directory, which `**` never
 *   matches: it is entered only when a later segment names it (such as a
 *   literal `.github` segment after the `**`).
 *
 * A pattern whose segments cannot be read one at a time — a brace, extglob or
 * class group spanning a `/`, an escape, a leading `!` negation — is not
 * pruned at all (the old full walk; still bounded by the visit cap).
 */
function createDirFilter(segments: readonly string[]): (relative: readonly string[]) => boolean {
  if (segments[0]?.startsWith("!") || segments.some(isUnsplittableSegment)) return () => true;
  // One matcher per depth, compiled on first use: the walk asks at every directory.
  const leadingByDepth: Minimatch[] = [];
  const leading = (relative: readonly string[]) => {
    const depth = relative.length;
    let matcher = leadingByDepth[depth];
    if (!matcher) {
      matcher = compileGlob(segments.slice(0, depth).join("/"));
      leadingByDepth[depth] = matcher;
    }
    return matcher.match(relative.join("/"));
  };
  // Conservative: a segment holding `**` anywhere counts as a globstar.
  const globstar = segments.findIndex((segment) => segment.includes("**"));
  if (globstar === -1) {
    return (relative) => relative.length < segments.length && leading(relative);
  }
  const later = segments
    .slice(globstar)
    .filter((segment) => segment !== "**")
    .map((segment) => compileGlob(segment));
  return (relative) => {
    if (relative.length <= globstar) return leading(relative);
    const name = relative[relative.length - 1] ?? "";
    if (!name.startsWith(".")) return true;
    return later.some((segment) => segment.match(name));
  };
}

function isUnsplittableSegment(segment: string): boolean {
  if (segment.includes("\\")) return true;
  const count = (char: string) => segment.split(char).length - 1;
  return count("{") !== count("}") || count("(") !== count(")") || count("[") !== count("]");
}

/**
 * Reject absolute and `..`-climbing patterns, including a `..` inside a brace
 * group (`{..,x}/**`). The walk cannot leave the root anyway (see
 * `exploreGlob`), so this is about telling the model why it got nothing.
 */
function assertRelativeGlob(pattern: string): void {
  if (path.isAbsolute(pattern) || pattern.split(/[\\/{},]/).includes("..")) {
    throw new Error("Glob pattern must be relative to the explore root (no absolute or ..).");
  }
}

/** Compile the model's pattern as a JavaScript RegExp, with the error the tool reports. */
export function compileGrepPattern(pattern: string, caseInsensitive?: boolean): RegExp {
  try {
    return new RegExp(pattern, caseInsensitive ? "i" : undefined);
  } catch (error) {
    throw new Error(
      `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function clampMaxMatches(maxMatches?: number): number {
  return Math.min(Math.max(maxMatches ?? DEFAULT_MAX_MATCHES, 1), MAX_GREP_MATCHES);
}

export function clipMatchText(line: string): string {
  return line.length > MAX_MATCH_TEXT_CHARS ? `${line.slice(0, MAX_MATCH_TEXT_CHARS)}…` : line;
}

/**
 * The JavaScript grep: the fallback when ripgrep is not on PATH or rejects the
 * pattern (see `ripgrep.ts`, which `exploreGrep` tries first). It runs in a
 * worker thread with a hard time budget (`grep-worker.ts`): a model-supplied
 * regex can backtrack catastrophically, and on the main thread nothing could
 * interrupt it. Same result shape, order and caps as the ripgrep path.
 */
export async function exploreGrepJs(
  root: string,
  pattern: string,
  options: GrepOptions = {},
): Promise<GrepResult> {
  const maxMatches = clampMaxMatches(options.maxMatches);
  const regex = compileGrepPattern(pattern, options.caseInsensitive);
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const base = resolveWithinRoot(root, options.searchPath ?? ".");
  // As a missing path searches nothing (see `GIT_METADATA_NAME`).
  if (isGitMetadataPath(rootReal, base)) return { matches: [], truncated: false };

  return runGrepWorker(
    {
      rootReal,
      base,
      pattern: regex.source,
      flags: regex.flags,
      maxMatches,
      maxFileBytes: MAX_FILE_BYTES,
      maxMatchTextChars: MAX_MATCH_TEXT_CHARS,
      skipDirNames: [...SKIP_DIR_NAMES],
      skipEntryNames: [GIT_METADATA_NAME],
      binaryExtensions: [...BINARY_EXTENSIONS],
    },
    { timeoutMs: options.timeoutMs ?? GREP_TIMEOUT_MS, signal: options.signal },
  );
}

export function exploreRead(
  root: string,
  relativePath: string,
  options: { offset?: number; limit?: number } = {},
): ReadResult {
  const absolute = resolveWithinRoot(root, relativePath);
  // Checked on the resolved path, so an in-root link to `.git` is refused too.
  if (isGitMetadataPath(fs.realpathSync.native(path.resolve(root)), absolute)) {
    throw gitMetadataNotFound(relativePath);
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large to read (${stat.size} bytes; max ${MAX_FILE_BYTES}): ${relativePath}`,
    );
  }

  const text = fs.readFileSync(absolute, "utf8");
  if (text.includes("\u0000")) {
    throw new Error(`Refusing to read binary file: ${relativePath}`);
  }

  const lines = text.split(/\r?\n/);
  const offset = Math.max(options.offset ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);
  const startIndex = offset - 1;

  // Whole lines only, under a character budget: half a line of source is worse
  // than none, because the model cannot tell which it got.
  const numbered: string[] = [];
  let used = 0;
  for (const [index, raw] of lines.slice(startIndex, startIndex + limit).entries()) {
    const line =
      raw.length > MAX_READ_LINE_CHARS
        ? `${raw.slice(0, MAX_READ_LINE_CHARS)}… [line clipped at ${MAX_READ_LINE_CHARS} chars]`
        : raw;
    const entry = `${startIndex + index + 1}|${line}`;
    if (numbered.length > 0 && used + entry.length + 1 > MAX_READ_CONTENT_CHARS) break;
    numbered.push(entry);
    used += entry.length + 1;
  }
  const truncated = startIndex + numbered.length < lines.length;

  return {
    path: toRelativeRootPath(root, absolute),
    offset,
    limit,
    totalLines: lines.length,
    content: numbered.join("\n"),
    truncated,
    ...(truncated ? { nextOffset: startIndex + numbered.length + 1 } : {}),
  };
}

const byName = (a: fs.Dirent, b: fs.Dirent): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
