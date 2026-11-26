/** Postgres refused a Serializable transaction (a concurrent one won); safe to retry. */
export function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034"
  );
}

/**
 * Run a Serializable transaction, retrying it while a concurrent one wins.
 * Nothing was written by a losing attempt, so a retry re-reads and re-checks
 * (a per-user limit holds). After `attempts` losses, throw `onExhausted()`
 * rather than a 500.
 */
export async function retrySerializable<T>(
  run: () => Promise<T>,
  options: { attempts: number; onExhausted: () => Error },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      if (attempt >= options.attempts) throw options.onExhausted();
    }
  }
}
