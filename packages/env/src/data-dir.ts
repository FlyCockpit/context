import fs from "node:fs";
import path from "node:path";

/**
 * Resolve `COCKPIT_CONTEXT_DATA_DIR` to an absolute path.
 *
 * - Absolute values are used as given (`/data` in the Docker image).
 * - Relative values resolve against the monorepo root, not the process cwd:
 *   turbo starts `apps/server` with its own package directory as cwd, so a
 *   cwd-relative `./.data` would land in `apps/server/.data`.
 * - Unset means `/data` in production and `<repo root>/.data` otherwise.
 *
 * `cwd` is injectable for tests. No dotenv here — this module is imported by
 * the validation graph (../server.ts).
 */
export function resolveCockpitContextDataDir(
  raw: string | undefined,
  nodeEnv: string,
  cwd: string = process.cwd(),
): string {
  if (raw && path.isAbsolute(raw)) return path.normalize(raw);
  if (!raw && nodeEnv === "production") return "/data";
  const base = findWorkspaceRoot(cwd) ?? cwd;
  return path.resolve(base, raw ?? ".data");
}

function findWorkspaceRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
