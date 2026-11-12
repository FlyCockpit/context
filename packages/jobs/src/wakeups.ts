import { createEventBus } from "./event-bus";

/**
 * In-process "work is waiting" signal. `enqueueJob()` publishes after an
 * insert so the runner claims it at once instead of on its next poll; the poll
 * remains the source of truth (a row written by another process, or inside a
 * transaction that had not committed yet, is still found).
 */
export const jobWakeups = createEventBus<{ type: string }>({ name: "jobs" });
