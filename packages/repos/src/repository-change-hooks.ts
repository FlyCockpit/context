/**
 * Listeners told that a repository's refs may have changed or the repository
 * is gone:
 * - `fetched`: any successful fetch (`fetchLocked`), including the automatic
 *   ones a version resolution makes;
 * - `refetched`: an explicit re-fetch (`fetchRepository`, the fetch job);
 * - `deleted`: the repository was removed.
 * The version→commit cache (./resolution-cache.ts) drops its entries for the
 * repository on every reason; the run engine's answer reuse drops answers on
 * `refetched` and `deleted` only (its keys hold the commit SHA, so a moved
 * ref is already a different key). A snapshot package update is handled by
 * the package invalidation instead (`forgetPackageReuse`). In process: one
 * app replica.
 */
export type RepositoryChangeReason = "fetched" | "refetched" | "deleted";

export type RepositoryChangeListener = (
  repositoryId: string,
  reason: RepositoryChangeReason,
) => void;

const listeners = new Set<RepositoryChangeListener>();

/** Register a listener; returns its unregister function. */
export function onRepositoryChange(listener: RepositoryChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Run every listener. A failing listener is logged and never fails the caller. */
export function notifyRepositoryChange(repositoryId: string, reason: RepositoryChangeReason): void {
  for (const listener of listeners) {
    try {
      listener(repositoryId, reason);
    } catch (error) {
      console.warn("[repos] repository change listener failed", error);
    }
  }
}
