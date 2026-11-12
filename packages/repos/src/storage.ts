import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

/**
 * Bounded recursive size walk for storage accounting
 * (docs/product.md).
 *
 * - `lstat` only: symlinks count as their own size and are never followed, so
 *   a checkout's `link -> /` cannot make the walk escape or loop.
 * - At most `maxEntries` entries and `maxDepth` levels; past either bound the
 *   result is a lower bound with `truncated: true`.
 * - Entries that vanish mid-walk (a concurrent prune) are skipped.
 */

export interface DirectorySize {
  bytes: bigint;
  entries: number;
  truncated: boolean;
}

interface MeasureOptions {
  maxEntries?: number;
  maxDepth?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ENTRIES = 2_000_000;
const DEFAULT_MAX_DEPTH = 128;
/** Concurrent `lstat` calls per walk: overlaps filesystem latency, bounds open requests. */
const MAX_LSTATS_IN_FLIGHT = 32;

/** A size function, injectable so pruning tests can use a fake filesystem. */
export type MeasureFn = (dir: string, options?: MeasureOptions) => Promise<DirectorySize>;

export const measureDirectory: MeasureFn = async (root, options = {}) => {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let bytes = 0n;
  let entries = 0;
  let truncated = false;

  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(root);
  } catch {
    return { bytes: 0n, entries: 0, truncated: false };
  }
  bytes += BigInt(rootStat.size);
  if (!rootStat.isDirectory()) return { bytes, entries: 1, truncated: false };

  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  // Directories are listed one at a time; their entries' lstats overlap, at
  // most MAX_LSTATS_IN_FLIGHT across the whole walk.
  const inFlight = new Set<Promise<void>>();
  const statEntry = (full: string, depth: number) => {
    const pending: Promise<void> = lstat(full)
      .then(
        (stat) => {
          bytes += BigInt(stat.size);
          if (stat.isDirectory()) {
            if (depth + 1 >= maxDepth) truncated = true;
            else stack.push({ dir: full, depth: depth + 1 });
          }
        },
        () => {
          // Removed while we walked.
        },
      )
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  };
  try {
    while (stack.length > 0 || inFlight.size > 0) {
      options.signal?.throwIfAborted();
      const current = stack.pop();
      if (!current) {
        // Subdirectories are still being discovered.
        await Promise.race(inFlight);
        continue;
      }
      let handle: Awaited<ReturnType<typeof opendir>>;
      try {
        handle = await opendir(current.dir);
      } catch {
        continue;
      }
      for await (const entry of handle) {
        if (entries >= maxEntries) {
          truncated = true;
          break;
        }
        entries += 1;
        while (inFlight.size >= MAX_LSTATS_IN_FLIGHT) await Promise.race(inFlight);
        statEntry(path.join(current.dir, entry.name), current.depth);
      }
      if (truncated && entries >= maxEntries) break;
    }
  } finally {
    // Every lstat started is counted (or finished) before returning or throwing.
    await Promise.all(inFlight);
  }
  return { bytes, entries, truncated };
};
