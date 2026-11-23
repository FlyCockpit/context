import prisma from "@cockpit-context/db";
import {
  cloneRepository,
  isRepoError,
  snapshotRefMissing,
  updateSnapshotRepository,
} from "@cockpit-context/repos";

/**
 * Snapshot packages' background clones and refreshes (docs/product.md,
 * docs/deploy.md § Home server behind a Cloudflare Tunnel).
 *
 * A snapshot is cloned with a pasted one-time SSH key that must never be
 * persisted: not in a job row, not in any column. So the task is an
 * in-process promise holding the key in memory only, and its STATE is durable
 * on the Repository row (`snapshotSyncStatus` RUNNING → NONE or FAILED with a
 * RepoError code in `snapshotSyncError`; `status` tells a first clone from a
 * refresh). The request that pasted the key answers at once.
 *
 * A restart cannot resume a task (the key is gone): boot recovery and the
 * periodic sweep (`sweepStaleSnapshotSyncs`) turn a RUNNING row this process
 * does not own into FAILED / SNAPSHOT_INTERRUPTED, and the package page asks
 * for the key again. One replica (docs/hosting.md), so this map is complete.
 */

/** The failure code for a task cut short by a restart (the key was lost with the process). */
export const SNAPSHOT_INTERRUPTED = "SNAPSHOT_INTERRUPTED";
/** The failure code for a task cancelled because its package was deleted or re-keyed. */
export const SNAPSHOT_CANCELLED = "SNAPSHOT_CANCELLED";

type Task = { controller: AbortController; done: Promise<void> };

const tasks = new Map<string, Task>();
/** Rows being converted to ordinary repositories: no task may start on them meanwhile. */
const closed = new Set<string>();

export type SnapshotSyncKind = "clone" | "refresh";

/**
 * Start the background clone (a new snapshot row) or refresh (fetch branches
 * and tags of an existing one) of `repositoryId` with `privateKey`, which
 * lives only in this task's closure. Idempotent: while one runs for the row,
 * a second call joins it (`started: false`) and never starts another. Throws
 * PACKAGE_SNAPSHOT_REF_MISSING when the row is not the owner's snapshot.
 */
export async function startSnapshotSync(input: {
  repositoryId: string;
  ownerId: string;
  privateKey: string;
  kind: SnapshotSyncKind;
  /** Called after a successful sync (caches of the packages on it are stale). */
  onSynced?: () => void;
}): Promise<{ started: boolean }> {
  if (closed.has(input.repositoryId)) throw snapshotRefMissing();
  if (tasks.has(input.repositoryId)) return { started: false };
  const controller = new AbortController();
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  // Registered before the first await: a concurrent call joins this one.
  tasks.set(input.repositoryId, { controller, done });
  try {
    const { count } = await prisma.repository.updateMany({
      where: { id: input.repositoryId, ownerId: input.ownerId, isSnapshot: true },
      data: {
        snapshotSyncStatus: "RUNNING",
        snapshotSyncError: null,
        snapshotSyncStartedAt: new Date(),
      },
    });
    if (count === 0) throw snapshotRefMissing();
  } catch (error) {
    tasks.delete(input.repositoryId);
    markDone();
    throw error;
  }
  void runTask(input, controller.signal).finally(() => {
    tasks.delete(input.repositoryId);
    markDone();
  });
  return { started: true };
}

async function runTask(
  input: {
    repositoryId: string;
    ownerId: string;
    privateKey: string;
    kind: SnapshotSyncKind;
    onSynced?: () => void;
  },
  signal: AbortSignal,
): Promise<void> {
  try {
    if (input.kind === "clone") {
      await cloneRepository(input.repositoryId, { privateKey: input.privateKey, signal });
    } else {
      await updateSnapshotRepository(
        input.repositoryId,
        input.ownerId,
        input.privateKey,
        {},
        {
          signal,
        },
      );
    }
    await prisma.repository.updateMany({
      where: { id: input.repositoryId, snapshotSyncStatus: "RUNNING" },
      data: { snapshotSyncStatus: "NONE", snapshotSyncError: null },
    });
    input.onSynced?.();
  } catch (error) {
    // Only the code: a snapshot's git output may echo what the key reached.
    const code = signal.aborted
      ? SNAPSHOT_CANCELLED
      : isRepoError(error)
        ? error.code
        : "GIT_FAILED";
    await prisma.repository
      .updateMany({
        where: { id: input.repositoryId, snapshotSyncStatus: "RUNNING" },
        data: { snapshotSyncStatus: "FAILED", snapshotSyncError: code },
      })
      .catch((writeError: unknown) => {
        console.warn(
          `[snapshots] could not record the failed sync of ${input.repositoryId}`,
          writeError,
        );
      });
    if (!signal.aborted) {
      console.warn(`[snapshots] ${input.kind} of ${input.repositoryId} failed: ${code}`);
    }
  }
}

/** Whether this process is cloning or refreshing the snapshot row. */
export function snapshotSyncRunning(repositoryId: string): boolean {
  return tasks.has(repositoryId);
}

/**
 * Abort the row's task, if any: its git process is killed, and it releases
 * the repository lock and marks the row FAILED / SNAPSHOT_CANCELLED as it
 * unwinds. Returns at once, never waiting for that: a caller that next
 * deletes the repository waits for the lock with REQUEST_LOCK_WAIT_MS (then
 * REPOSITORY_BUSY), so no request waits on a slow cleanup.
 */
export function cancelSnapshotSync(repositoryId: string): void {
  tasks.get(repositoryId)?.controller.abort();
}

/**
 * Run `convert` (turning the snapshot row into an ordinary repository) with
 * task admission closed for the row: its running task, if any, is aborted
 * first, and a concurrent `startSnapshotSync` is refused until `convert` is
 * done, so no pasted-key task can slip in between the cancel and the write.
 */
export async function withSnapshotTasksClosed<T>(
  repositoryId: string | null,
  convert: () => Promise<T>,
): Promise<T> {
  if (!repositoryId) return convert();
  closed.add(repositoryId);
  try {
    cancelSnapshotSync(repositoryId);
    return await convert();
  } finally {
    closed.delete(repositoryId);
  }
}

const packageGates = new Map<string, Promise<void>>();

/**
 * Serialize the snapshot operations of one package (re-key, re-key and save,
 * convert to an ordinary package), so each reads the package's repository
 * AFTER the previous one wrote it: two concurrent requests can then never act
 * on different repository rows (one attaching a replacement clone while the
 * other converts the package). Each holder only does fast work (rows, task
 * start), so a waiter waits milliseconds, never for a clone.
 */
export async function withSnapshotPackageGate<T>(
  packageId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = packageGates.get(packageId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  packageGates.set(packageId, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (packageGates.get(packageId) === tail) packageGates.delete(packageId);
  }
}

/** Abort every snapshot task of `ownerId`'s repositories (account deletion). */
export function cancelSnapshotSyncs(repositoryIds: readonly string[]): void {
  for (const id of repositoryIds) cancelSnapshotSync(id);
}

/** Settles once the row's task (if any) has ended. Tests and shutdown only. */
export async function snapshotSyncSettled(repositoryId: string): Promise<void> {
  await tasks.get(repositoryId)?.done;
}

/**
 * RUNNING rows that no task of this process owns become FAILED /
 * SNAPSHOT_INTERRUPTED: at boot (`graceMs` 0, nothing is running yet) and
 * periodically, for a row whose final write failed. Returns how many moved.
 */
export async function sweepStaleSnapshotSyncs(graceMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const { count } = await prisma.repository.updateMany({
    where: {
      snapshotSyncStatus: "RUNNING",
      id: { notIn: [...tasks.keys()] },
      OR: [{ snapshotSyncStartedAt: null }, { snapshotSyncStartedAt: { lte: cutoff } }],
    },
    data: { snapshotSyncStatus: "FAILED", snapshotSyncError: SNAPSHOT_INTERRUPTED },
  });
  return count;
}
