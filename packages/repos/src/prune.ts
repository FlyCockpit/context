import prisma from "@cockpit-context/db";

import { deleteCheckout } from "./checkouts";
import { maxStorageBytes } from "./config";
import { isRepoError } from "./errors";
import { withLock } from "./locks";
import { deleteRepository, type GitLayerDeps, measure, totalStorageBytes } from "./repositories";

/**
 * Storage accounting and automatic pruning (docs/product.md). One pass, serialized process-wide:
 *
 *   0. optionally re-measure every clone and checkout (the hourly job);
 *   1. while the total exceeds `COCKPIT_CONTEXT_MAX_STORAGE_GB`, evict until it is under
 *      90 % of the cap, in this order:
 *      a. unleased checkouts, least recently used first;
 *      b. repositories with no checkouts left and no package pointing at them;
 *      c. repositories still referenced by a package but not in use (no
 *         leased checkout). Their packages re-clone on demand.
 *
 * Leases are respected by the delete services themselves: `deleteCheckout`
 * and `deleteRepository` re-check for an unexpired lease under the
 * repository lock and refuse with CHECKOUT_LEASED, which this pass skips.
 * Lease admission uses that same lock: it either wins before the lease check,
 * or waits for deletion and fails its FK check so the caller retries. Deleting
 * notifies removal listeners first to stop the checkout's language servers.
 */

const PRUNE_LOCK_KEY = "storage:prune";
/** Candidates fetched per query; the loop re-queries as rows disappear. */
const PAGE = 50;
/** Hard stop on evictions per pass, far above any real data volume. */
const MAX_EVICTIONS = 10_000;
/** Repositories measured per page in the measuring pass. */
const MEASURE_PAGE = 100;

export interface PruneStorageOptions {
  /** Re-measure every clone and checkout first (hourly job). */
  measure?: boolean;
  /** Override `COCKPIT_CONTEXT_MAX_STORAGE_GB` (tests, admin "prune now" with a cap). */
  capBytes?: bigint;
  signal?: AbortSignal;
}

export interface PruneStorageResult {
  capBytes: bigint;
  targetBytes: bigint;
  beforeBytes: bigint;
  afterBytes: bigint;
  /** Repositories re-measured (0 unless `measure`). */
  measured: number;
  evictedCheckouts: string[];
  evictedRepositories: string[];
  /**
   * True when another pass held the prune lock: this call only asked it to
   * run one more eviction pass before releasing, and evicted nothing itself.
   */
  coalesced?: boolean;
}

const lruOrder = [{ lastUsedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }] as const;

/** Bound on extra passes one holder runs for requests that arrived meanwhile. */
const MAX_RERUNS = 10;

/** Process-local (one app replica): whether a pass holds the lock, and whether one more was asked for. */
const pruneState = { running: false, rerunRequested: false };

/**
 * One prune pass, serialized process-wide. A plain eviction request
 * (no `measure`, no explicit `capBytes`: the `checkout-created` job) that
 * finds another pass running does not wait for it — the hourly measuring pass
 * can hold the lock for minutes, and a waiting job holds a job slot. It
 * asks the holder for one more eviction pass instead and returns at once
 * (`coalesced`). The holder runs that pass after its current one, before it
 * releases the lock. Measuring prunes and explicit caps queue as before.
 */
export async function pruneStorage(
  options: PruneStorageOptions = {},
  deps: GitLayerDeps = {},
): Promise<PruneStorageResult> {
  const coalescible = !options.measure && options.capBytes === undefined;
  if (coalescible && pruneState.running) {
    pruneState.rerunRequested = true;
    const capBytes = maxStorageBytes();
    const total = await totalStorageBytes();
    return {
      capBytes,
      targetBytes: (capBytes * 9n) / 10n,
      beforeBytes: total,
      afterBytes: total,
      measured: 0,
      evictedCheckouts: [],
      evictedRepositories: [],
      coalesced: true,
    };
  }
  return withLock(PRUNE_LOCK_KEY, async () => {
    pruneState.running = true;
    try {
      const result = await prunePass(options, deps);
      for (let rerun = 0; pruneState.rerunRequested && rerun < MAX_RERUNS; rerun += 1) {
        pruneState.rerunRequested = false;
        const extra = await prunePass({ signal: options.signal }, deps);
        result.evictedCheckouts.push(...extra.evictedCheckouts);
        result.evictedRepositories.push(...extra.evictedRepositories);
        result.afterBytes = extra.afterBytes;
      }
      return result;
    } finally {
      pruneState.running = false;
    }
  });
}

async function prunePass(
  options: PruneStorageOptions,
  deps: GitLayerDeps,
): Promise<PruneStorageResult> {
  const measured = options.measure ? await measureAll(options.signal, deps) : 0;
  const capBytes = options.capBytes ?? maxStorageBytes();
  const targetBytes = (capBytes * 9n) / 10n;
  const beforeBytes = await totalStorageBytes();
  const result: PruneStorageResult = {
    capBytes,
    targetBytes,
    beforeBytes,
    afterBytes: beforeBytes,
    measured,
    evictedCheckouts: [],
    evictedRepositories: [],
  };
  if (beforeBytes <= capBytes) return result;

  let total = beforeBytes;
  let evictions = 0;
  const done = () => total < targetBytes || evictions >= MAX_EVICTIONS;
  const now = () => deps.now?.() ?? new Date();

  // a. Unleased checkouts. PENDING rows are being created right now (a job
  //    or a run that leases next), so they are left alone.
  const skippedCheckouts: string[] = [];
  while (!done()) {
    options.signal?.throwIfAborted();
    const page = await prisma.checkout.findMany({
      where: {
        id: { notIn: skippedCheckouts },
        status: { not: "PENDING" },
        Leases: { none: { expiresAt: { gt: now() } } },
      },
      orderBy: [...lruOrder],
      select: { id: true },
      take: PAGE,
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (done()) break;
      const freed = await evict(() => deleteCheckout(row.id, {}, deps));
      if (freed === null) {
        skippedCheckouts.push(row.id);
        continue;
      }
      total -= freed;
      evictions += 1;
      result.evictedCheckouts.push(row.id);
    }
  }

  // b. then c. Repositories: orphans first, then referenced-but-unused ones.
  const skippedRepositories: string[] = [];
  for (const referenced of [false, true]) {
    while (!done()) {
      options.signal?.throwIfAborted();
      const page = await prisma.repository.findMany({
        where: {
          id: { notIn: skippedRepositories },
          isSnapshot: false,
          // A clone in progress is not "unused".
          status: { not: "CLONING" },
          ...(referenced
            ? { Checkouts: { none: { Leases: { some: { expiresAt: { gt: now() } } } } } }
            : { Checkouts: { none: {} }, Packages: { none: {} } }),
        },
        orderBy: [...lruOrder],
        select: { id: true },
        take: PAGE,
      });
      if (page.length === 0) break;
      for (const row of page) {
        if (done()) break;
        const freed = await evict(() => deleteRepository(row.id, {}, deps));
        if (freed === null) {
          skippedRepositories.push(row.id);
          continue;
        }
        total -= freed;
        evictions += 1;
        result.evictedRepositories.push(row.id);
      }
    }
  }

  result.afterBytes = total < 0n ? 0n : total;
  if (
    result.afterBytes > capBytes &&
    (await prisma.repository.count({ where: { isSnapshot: true } })) > 0
  ) {
    console.warn(
      "[repos] storage cap cannot be met while snapshot clones are protected; remove snapshots manually or raise the cap.",
    );
  }
  return result;
}

/**
 * Run one delete. A lease taken since the candidate query (CHECKOUT_LEASED),
 * a row already gone, or a filesystem error skips the candidate (`null`)
 * instead of failing the pass.
 */
async function evict(remove: () => Promise<{ freedBytes: bigint }>): Promise<bigint | null> {
  try {
    return (await remove()).freedBytes;
  } catch (error) {
    if (!isRepoError(error) || error.code !== "CHECKOUT_LEASED") {
      console.warn("[repos] prune could not remove a candidate", error);
    }
    return null;
  }
}

/** Re-measure every repository and its checkouts (bounded size walks). */
async function measureAll(signal: AbortSignal | undefined, deps: GitLayerDeps): Promise<number> {
  let measured = 0;
  let cursor: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await prisma.repository.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      select: { id: true },
      take: MEASURE_PAGE,
    });
    if (page.length === 0) return measured;
    for (const row of page) {
      try {
        await measure(row.id, { signal }, deps);
        measured += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[repos] could not measure repository ${row.id}`, error);
      }
    }
    cursor = page[page.length - 1]?.id;
  }
}
