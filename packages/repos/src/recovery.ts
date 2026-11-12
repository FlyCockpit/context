import { readdir } from "node:fs/promises";
import path from "node:path";

import prisma from "@cockpit-context/db";

import { removeWorktree } from "./checkouts";
import { repositoryLockKey, withLock } from "./locks";
import { checkoutDir, removeInsideDataDir, reposRoot } from "./paths";

/**
 * Boot recovery for git work a crash interrupted (docs/product.md).
 * Called once at boot, before the job runner starts and after interrupted runs
 * released their leases. Cockpit Context is a single process (docs/hosting.md), so
 * nothing is cloning or adding a worktree at that point:
 *
 * - repositories still `CLONING` become `FAILED` (the next use re-clones;
 *   pruning never evicts a `CLONING` row, so it would otherwise stay forever);
 * - clone staging directories (`repos/<id>.git.clone-<hex>`) are removed;
 * - checkouts still `PENDING` with no unexpired lease become `FAILED` and
 *   lose any partial worktree (the next use re-adds it; pruning skips
 *   `PENDING` rows, and the UI would poll them forever).
 */

export const INTERRUPTED_BY_RESTART = "Interrupted by a server restart; retry to continue.";

/** `<repository id>.git.clone-<12 hex>`: exactly what cloneRepository stages into. */
const STAGING_DIR = /^[A-Za-z0-9-]{8,64}\.git\.clone-[0-9a-f]{12}$/;
const PAGE = 100;
/** Hard stop on checkouts reset per boot, far above any real data volume. */
const MAX_CHECKOUTS = 10_000;

export interface RecoveryResult {
  repositories: number;
  stagingDirs: number;
  checkouts: number;
}

export async function recoverInterruptedGitWork(
  deps: { now?: () => Date } = {},
): Promise<RecoveryResult> {
  const { count: repositories } = await prisma.repository.updateMany({
    where: { status: "CLONING" },
    data: { status: "FAILED", lastError: INTERRUPTED_BY_RESTART },
  });
  const stagingDirs = await removeStagingDirs();
  const checkouts = await recoverPendingCheckouts(deps.now?.() ?? new Date());
  return { repositories, stagingDirs, checkouts };
}

async function removeStagingDirs(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(reposRoot());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!STAGING_DIR.test(entry)) continue;
    await removeInsideDataDir(path.join(reposRoot(), entry));
    removed += 1;
  }
  return removed;
}

async function recoverPendingCheckouts(now: Date): Promise<number> {
  const unleasedPending = {
    status: "PENDING" as const,
    Leases: { none: { expiresAt: { gt: now } } },
  };
  let recovered = 0;
  let cursor: string | undefined;
  while (recovered < MAX_CHECKOUTS) {
    const page = await prisma.checkout.findMany({
      where: { ...unleasedPending, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      select: { id: true, repositoryId: true, sha: true },
      take: PAGE,
    });
    if (page.length === 0) break;
    for (const row of page) {
      try {
        await withLock(repositoryLockKey(row.repositoryId), async () => {
          // Re-checked under the lock, before anything is removed.
          const still = await prisma.checkout.count({ where: { id: row.id, ...unleasedPending } });
          if (still === 0) return;
          await removeWorktree(row.repositoryId, checkoutDir(row.repositoryId, row.sha));
          const { count } = await prisma.checkout.updateMany({
            where: { id: row.id, ...unleasedPending },
            data: { status: "FAILED", lastError: INTERRUPTED_BY_RESTART, diskBytes: 0n },
          });
          recovered += count;
        });
      } catch (error) {
        console.warn(`[repos] could not recover interrupted checkout ${row.id}`, error);
      }
    }
    cursor = page[page.length - 1]?.id;
  }
  return recovered;
}
