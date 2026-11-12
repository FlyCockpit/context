/**
 * Process-local keyed mutex. git operations on one repository (clone, fetch,
 * worktree add/remove) are serialized per repository id. Cockpit Context runs exactly one
 * app replica (docs/hosting.md), so an in-memory lock is sufficient; the
 * job table's SKIP LOCKED claim keeps two jobs off one row besides.
 */
const tails = new Map<string, Promise<void>>();

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
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
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.then(resolve);
      if (signal?.aborted) onAbort();
    });
    signal?.throwIfAborted();
    return await fn();
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    release();
  }
}

/** Lease admission and repository/checkout deletion share this lifecycle gate. */
export function withRepositoryLock<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(repositoryLockKey(repositoryId), fn);
}

export function repositoryLockKey(repositoryId: string): string {
  return `repository:${repositoryId}`;
}
