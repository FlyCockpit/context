import type { JobDefinition } from "./define";
import { enqueueJob } from "./store";

export type PeriodicSchedule<TPayload> = {
  definition: JobDefinition<string, TPayload>;
  payload: TPayload;
  /** Slot length. One job per slot, e.g. `24 * HOUR` for a daily sweep. */
  everyMs: number;
  /**
   * Where each slot starts, measured from the Unix epoch (UTC). `4h17m` with
   * `everyMs = 24h` means "daily at 04:17 UTC". Default 0.
   */
  offsetMs?: number;
};

export type SlotClock = {
  setTimeout(callback: () => void, ms: number): { unref(): void };
  clearTimeout(handle: unknown): void;
  now(): number;
};

const realClock: SlotClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Start of the slot containing `at`. */
export function slotStart(at: number, everyMs: number, offsetMs = 0): number {
  return Math.floor((at - offsetMs) / everyMs) * everyMs + offsetMs;
}

/**
 * Recurring jobs without cron. Each slot of `everyMs` (anchored at `offsetMs`
 * past the epoch) gets exactly one row, deduplicated by a slot key, so:
 *
 *   - a restart inside a slot does not enqueue it again;
 *   - a process that was down when a slot began catches up on boot (the
 *     current slot's row is enqueued with `runAt` = slot start, i.e. due now);
 *   - missed slots older than the current one are NOT replayed — a sweep that
 *     missed yesterday only needs to run once today.
 *
 * Returns `stop`. The timer is `unref()`'d.
 */
export function startPeriodicJob<TPayload>(
  schedule: PeriodicSchedule<TPayload>,
  clock: SlotClock = realClock,
): () => void {
  const { definition, payload, everyMs, offsetMs = 0 } = schedule;
  if (!(everyMs >= 60_000)) {
    throw new Error(`Periodic job "${definition.type}" needs everyMs >= 60000.`);
  }
  let stopped = false;
  let timer: unknown;

  async function enqueueCurrentSlot() {
    const start = slotStart(clock.now(), everyMs, offsetMs);
    try {
      await enqueueJob(definition, payload, {
        runAt: new Date(start),
        dedupeKey: `periodic:${definition.type}:${new Date(start).toISOString()}`,
      });
    } catch (error) {
      // The next slot boundary retries; the error is visible in logs.
      console.error(
        `[jobs] Could not enqueue periodic ${definition.type}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  function armNext() {
    if (stopped) return;
    const next = slotStart(clock.now(), everyMs, offsetMs) + everyMs;
    // +1 s so the tick lands inside the new slot even with timer jitter.
    const handle = clock.setTimeout(
      () => {
        void enqueueCurrentSlot().finally(armNext);
      },
      Math.max(1_000, next - clock.now() + 1_000),
    );
    handle.unref();
    timer = handle;
  }

  void enqueueCurrentSlot().finally(armNext);

  return () => {
    stopped = true;
    clock.clearTimeout(timer);
  };
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
