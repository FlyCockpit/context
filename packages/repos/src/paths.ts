import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "./config";

/**
 * The storage layout under COCKPIT_CONTEXT_DATA_DIR (docs/product.md):
 *
 *   repos/<repositoryId>.git          bare, blobless clone
 *   checkouts/<repositoryId>/<sha>/   detached worktree
 *   tmp/                              per-invocation SSH key + known_hosts dirs
 *   repos/.trash/, checkouts/.trash/  deleted clones and worktrees, removed in
 *                                     the background (sweepTrash); one per root
 *                                     so a rename never crosses filesystems
 *
 * Every path is built from a validated id or SHA, never from user text, and
 * every destructive helper re-checks that its target sits inside the root.
 */

/** Row ids are cuid2 (Prisma) or UUIDs: letters, digits and dashes only. */
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertSafeId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Refusing unsafe storage id ${JSON.stringify(id)}.`);
  return id;
}

export function assertFullSha(sha: string): string {
  if (!FULL_SHA_PATTERN.test(sha)) throw new Error("Expected a full 40-hex commit SHA.");
  return sha;
}

export function reposRoot(): string {
  return path.join(dataDir(), "repos");
}

function checkoutsRoot(): string {
  return path.join(dataDir(), "checkouts");
}

export function tmpRoot(): string {
  return path.join(dataDir(), "tmp");
}

/** The trash directory of the root `target` sits in (repos/ or checkouts/). */
function trashFor(root: string): string {
  return path.join(root, ".trash");
}

/** Every trash directory `sweepTrash` empties. */
export function trashRoots(): string[] {
  return [trashFor(reposRoot()), trashFor(checkoutsRoot())];
}

export function repositoryDir(repositoryId: string): string {
  return path.join(reposRoot(), `${assertSafeId(repositoryId)}.git`);
}

export function repositoryCheckoutsDir(repositoryId: string): string {
  return path.join(checkoutsRoot(), assertSafeId(repositoryId));
}

export function checkoutDir(repositoryId: string, sha: string): string {
  return path.join(repositoryCheckoutsDir(repositoryId), assertFullSha(sha));
}

/** Create the roots (0700: clones of private repos and key files live here). */
export async function ensureDataDirs(): Promise<void> {
  for (const dir of [reposRoot(), checkoutsRoot(), tmpRoot(), ...trashRoots()]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/** `target`, resolved, when it sits strictly inside one of `roots`; throws otherwise. */
function insideRoots(target: string, roots: string[]): string {
  const resolved = path.resolve(target);
  const inside = roots
    .map((root) => path.resolve(root))
    .some((root) => resolved.startsWith(`${root}${path.sep}`));
  if (!inside)
    throw new Error(`Refusing to remove ${resolved}: outside the Cockpit Context data directory.`);
  return resolved;
}

/**
 * `rm -rf` confined to the data root: the target must be strictly inside one
 * of the roots, so a bad id can never remove the root itself or escape.
 */
export async function removeInsideDataDir(target: string): Promise<void> {
  const resolved = insideRoots(target, [reposRoot(), checkoutsRoot(), tmpRoot()]);
  await rm(resolved, { recursive: true, force: true });
}

/**
 * Take a clone or worktree out of service at once: rename it into its root's
 * trash directory (one directory entry, however large the tree), and let
 * `sweepTrash` remove the files in the background. A request deleting a
 * large clone on a slow disk then never waits for the files themselves. A
 * missing target is fine. The trash sits in the same root, so the rename
 * stays on one filesystem; a target that is itself a mount point (EXDEV,
 * EBUSY) is refused at once rather than removed in place.
 */
export async function moveToTrash(target: string): Promise<void> {
  const resolved = insideRoots(target, [reposRoot(), checkoutsRoot()]);
  const root = [reposRoot(), checkoutsRoot()]
    .map((entry) => path.resolve(entry))
    .find((entry) => resolved.startsWith(`${entry}${path.sep}`));
  if (!root) throw new Error(`Refusing to remove ${resolved}: outside the data directory.`);
  const trash = trashFor(root);
  if (resolved === trash || resolved.startsWith(`${trash}${path.sep}`)) {
    throw new Error(`Refusing to remove ${resolved}: already in the trash.`);
  }
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const destination = path.join(trash, `${Date.now()}-${randomBytes(6).toString("hex")}`);
  try {
    await rename(resolved, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  scheduleTrashSweep();
}

let sweeping: Promise<number> | null = null;
let sweepAgain = false;

/**
 * Remove everything in trash/. Single flight: a call during a sweep makes that
 * sweep run once more instead of starting a second one. A failure is logged
 * and left for the next sweep (boot, or the next delete).
 */
export function sweepTrash(): Promise<number> {
  if (sweeping) {
    sweepAgain = true;
    return sweeping;
  }
  sweeping = (async () => {
    let removed = 0;
    do {
      sweepAgain = false;
      for (const trash of trashRoots()) {
        let entries: string[];
        try {
          entries = await readdir(trash);
        } catch {
          continue;
        }
        for (const entry of entries) {
          try {
            await removeInsideDataDir(path.join(trash, entry));
            removed += 1;
          } catch (error) {
            console.warn(`[repos] could not empty trash entry ${entry}`, error);
          }
        }
      }
    } while (sweepAgain);
    return removed;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

function scheduleTrashSweep(): void {
  void sweepTrash().catch((error: unknown) => {
    console.warn("[repos] could not empty the trash", error);
  });
}

/** A fresh 0700 directory under tmp/ for one git/ssh invocation. */
export async function makeInvocationTmpDir(): Promise<string> {
  await mkdir(tmpRoot(), { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(tmpRoot(), "inv-"));
}

/**
 * Remove everything under tmp/. Called once at boot: Cockpit Context is a single
 * process, so anything left there is from a crashed invocation and may hold a
 * decrypted private key.
 */
export async function sweepTmpDir(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tmpRoot());
  } catch {
    return 0;
  }
  for (const entry of entries) {
    await removeInsideDataDir(path.join(tmpRoot(), entry));
  }
  return entries.length;
}
