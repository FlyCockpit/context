/** The API composition root supplies repository/run cleanup without an auth → API cycle. */
let cleanup: ((userId: string) => Promise<void>) | undefined;

export function registerUserDeletionCleanup(fn: (userId: string) => Promise<void>): void {
  cleanup = fn;
}

/** Fail closed if auth is hosted without the application's deletion service. */
export async function cleanupBeforeUserDeletion(userId: string): Promise<void> {
  if (!cleanup) throw new Error("User deletion cleanup is not configured.");
  await cleanup(userId);
}
