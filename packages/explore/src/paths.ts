import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a model-supplied path so it cannot escape `root`.
 *
 * Uses `realpathSync.native` when the path exists so a symlink planted inside
 * the tree cannot walk out; for non-existent targets (create paths, missing
 * files) falls back to lexical resolution under the real root.
 */
export function resolveWithinRoot(root: string, relativePath = "."): string {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const candidate = path.resolve(rootReal, relativePath);

  // Lexical check first — cheap reject before touching the filesystem.
  assertInside(rootReal, candidate, relativePath);

  try {
    const real = fs.realpathSync.native(candidate);
    assertInside(rootReal, real, relativePath);
    return real;
  } catch (error) {
    if (isNotFound(error)) {
      // Parent must still be inside the root (handles `../secret` via missing leaf).
      const parentReal = fs.realpathSync.native(path.dirname(candidate));
      assertInside(rootReal, parentReal, relativePath);
      return candidate;
    }
    throw error;
  }
}

export function toRelativeRootPath(root: string, absolutePath: string): string {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const real = fs.realpathSync.native(path.resolve(absolutePath));
  assertInside(rootReal, real, path.basename(absolutePath));
  const relative = path.relative(rootReal, real);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

/**
 * The error goes back to the model, so it names only what the model asked for —
 * never the absolute host path or a symlink's real target (which would reveal
 * the server's checkout layout and confirm where a planted link points).
 */
function assertInside(rootReal: string, candidate: string, requested: string): void {
  if (candidate === rootReal) return;
  if (candidate.startsWith(rootReal + path.sep)) return;
  throw new Error(`Path escapes explore root: ${requested}`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Git's own metadata, which no tool may list, search or read: a `.git`
 * directory, and also the `.git` FILE at the root of a linked worktree (or a
 * submodule), whose `gitdir: /data/repos/<id>.git/worktrees/<sha>` line names a
 * host path. `SKIP_DIR_NAMES` alone only catches the directory.
 */
export const GIT_METADATA_NAME = ".git";

/** Whether `absolute` (confined under `rootReal`) is, or is inside, a `.git` entry. */
export function isGitMetadataPath(rootReal: string, absolute: string): boolean {
  return path.relative(rootReal, absolute).split(path.sep).includes(GIT_METADATA_NAME);
}

/**
 * The error for a refused `.git` path: reported exactly like a missing file
 * (`code: "ENOENT"`, which the tools turn into `Not found: <requested>`), so it
 * neither names a host path nor confirms the entry exists.
 */
export function gitMetadataNotFound(requested: string): Error {
  return Object.assign(new Error(`Not found: ${requested}`), { code: "ENOENT" });
}

/** Directories we never descend into while exploring a dependency checkout. */
export const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
