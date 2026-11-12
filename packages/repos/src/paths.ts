import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "./config";

/**
 * The storage layout under COCKPIT_CONTEXT_DATA_DIR (docs/product.md):
 *
 *   repos/<repositoryId>.git          bare, blobless clone
 *   checkouts/<repositoryId>/<sha>/   detached worktree
 *   tmp/                              per-invocation SSH key + known_hosts dirs
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

export function repositoryDir(repositoryId: string): string {
  return path.join(reposRoot(), `${assertSafeId(repositoryId)}.git`);
}

export function repositoryCheckoutsDir(repositoryId: string): string {
  return path.join(checkoutsRoot(), assertSafeId(repositoryId));
}

export function checkoutDir(repositoryId: string, sha: string): string {
  return path.join(repositoryCheckoutsDir(repositoryId), assertFullSha(sha));
}

/** Create the three roots (0700: clones of private repos and key files live here). */
export async function ensureDataDirs(): Promise<void> {
  for (const dir of [reposRoot(), checkoutsRoot(), tmpRoot()]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * `rm -rf` confined to the data root: the target must be strictly inside one
 * of the three roots, so a bad id can never remove the root itself or escape.
 */
export async function removeInsideDataDir(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const roots = [reposRoot(), checkoutsRoot(), tmpRoot()].map((root) => path.resolve(root));
  const inside = roots.some((root) => resolved.startsWith(`${root}${path.sep}`));
  if (!inside)
    throw new Error(`Refusing to remove ${resolved}: outside the Cockpit Context data directory.`);
  await rm(resolved, { recursive: true, force: true });
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
