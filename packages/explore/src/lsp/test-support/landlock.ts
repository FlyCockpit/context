import { spawnSync } from "node:child_process";
import path from "node:path";

import { findLandlockHelper, probeLandlock } from "../sandbox";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

/**
 * The real Landlock helper for integration tests: builds it with the host's
 * C compiler when missing or stale (scripts/build-landlock-helper.mjs, the
 * same script dev and the image use), then probes it. `skip` says why the
 * integration tests cannot run here (no compiler, not Linux, a kernel without
 * Landlock); the tests print it through `describe.skipIf`.
 */
export async function realLandlockHelper(): Promise<
  | { helper: string; abi: number; tcp: boolean; scoping: boolean; skip?: undefined }
  | { skip: string }
> {
  if (process.platform !== "linux") return { skip: "Landlock is Linux-only" };
  const build = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/build-landlock-helper.mjs"), "--if-possible"],
    { encoding: "utf8", timeout: 60_000 },
  );
  const helper = findLandlockHelper({ production: false });
  if (!helper) {
    return { skip: `no Landlock helper (${(build.stdout + build.stderr).trim()})` };
  }
  const probe = await probeLandlock(helper);
  if (!probe.ok) return { skip: `Landlock unavailable here: ${probe.detail}` };
  return { helper, abi: probe.abi, tcp: probe.tcp, scoping: probe.scoping };
}
