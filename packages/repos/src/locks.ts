/**
 * Process-local keyed mutex. git operations on one repository (clone, fetch,
 * worktree add/remove) are serialized per repository id. Cockpit Context runs exactly one
 * app replica (docs/hosting.md), so an in-memory lock is sufficient; the
 * job table's SKIP LOCKED claim keeps two jobs off one row besides.
 */
import { RepoError } from "./errors";

const tails = new Map<string, Promise<void>>();

/**
 * How long a request handler waits for a repository's lock before it answers
 * REPOSITORY_BUSY. A clone or fetch can hold the lock for many minutes, and a
 * request must answer well inside a reverse proxy's idle limit (Cloudflare:
 * 100 s, docs/deploy.md); background work keeps waiting without a bound.
 */
export const REQUEST_LOCK_WAIT_MS = 10_000;

export type LockOptions = {
  /**
   * Give up waiting after this long with RepoError REPOSITORY_BUSY. Only the
   * wait is bounded: once held, `fn` runs to its end. A waiter that gives up
   * leaves the queue at once (later waiters are not held up by it).
   */
  waitMs?: number;
};

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options: LockOptions = {},
): Promise<T> {
  signal?.throwIfAborted();
  const previous = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  let onAbort: (() => void) | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.then(resolve);
      if (signal?.aborted) onAbort();
      if (options.waitMs !== undefined) {
        waitTimer = setTimeout(
          () =>
            reject(
              new RepoError(
                "REPOSITORY_BUSY",
                "Another clone, fetch or checkout of this repository is still running.",
              ),
            ),
          options.waitMs,
        );
      }
    });
    clearTimeout(waitTimer);
    signal?.throwIfAborted();
    return await fn();
  } finally {
    clearTimeout(waitTimer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    release();
  }
}

/** Whether `key` has a holder or a waiter (its queue has not settled). Tests only. */
export function isLockQueued(key: string): boolean {
  return tails.has(key);
}

/** Lease admission and repository/checkout deletion share this lifecycle gate. */
export function withRepositoryLock<T>(
  repositoryId: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return withLock(repositoryLockKey(repositoryId), fn, undefined, options);
}

export function repositoryLockKey(repositoryId: string): string {
  return `repository:${repositoryId}`;
}
