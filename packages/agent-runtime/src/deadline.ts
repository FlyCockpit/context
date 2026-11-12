/**
 * Wall-clock deadline support for the agent loop.
 *
 * With iteration caps relaxed (expand 60 / leaf 100 / reduce 40, `null` = unlimited) and
 * cost caps optional, wall-clock time is the primary backstop against a run that never
 * terminates. The runtime half is here: the loop takes a relative timeout and/or an
 * absolute deadline, stops cleanly at the earlier of the two, and reports it with a
 * distinct stop reason instead of looking like a clean finish.
 *
 * It cooperates with the existing abort plumbing rather than duplicating it: expiry
 * aborts the same `AbortController` the loop already threads through `chat()` and the
 * retry/failover adapter, using {@link DEADLINE_ABORT_REASON} as the abort reason so an
 * abort caused by the deadline stays distinguishable from a caller-requested cancel.
 */

/** Abort reason used when the loop's wall-clock deadline elapses. */
export const DEADLINE_ABORT_REASON = "agent-runtime:wall-clock-deadline-exceeded";

/** True when an `AbortSignal.reason` came from a deadline rather than a caller cancel. */
export const isDeadlineAbort = (reason: unknown): boolean => reason === DEADLINE_ABORT_REASON;

/** The subset of loop options that determine the effective deadline. */
export interface DeadlineOptions {
  /** Relative wall-clock budget in ms, measured from loop start. `null` disables it. */
  timeoutMs?: number | null;
  /** Absolute epoch-ms deadline (e.g. a shared per-run deadline). `null` disables it. */
  deadlineAt?: number | null;
}

/**
 * The effective absolute deadline, or `null` when the loop is uncapped in time.
 * When both a relative timeout and an absolute deadline are given, the earlier wins —
 * that is exactly the per-node (relative) vs per-run (absolute) pairing.
 */
export const resolveDeadlineAt = (options: DeadlineOptions, now: number): number | null => {
  const candidates: number[] = [];
  const { timeoutMs, deadlineAt } = options;
  if (timeoutMs !== undefined && timeoutMs !== null && Number.isFinite(timeoutMs)) {
    candidates.push(now + Math.max(0, timeoutMs));
  }
  if (deadlineAt !== undefined && deadlineAt !== null && Number.isFinite(deadlineAt)) {
    candidates.push(deadlineAt);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
};

/** A live deadline: checked between iterations and enforced mid-stream via abort. */
export interface DeadlineHandle {
  /** The resolved absolute deadline, or `null` when uncapped. */
  readonly deadlineAt: number | null;
  /** True once the deadline has elapsed (or its timer fired). */
  expired: () => boolean;
  /** Stop the timer. Idempotent; always called from a `finally`. */
  cancel: () => void;
}

/**
 * Arm the deadline. Expiry aborts `abortController` with {@link DEADLINE_ABORT_REASON}
 * so an in-flight provider stream is cut off promptly instead of running to completion.
 */
export const startDeadline = (
  options: DeadlineOptions,
  abortController: AbortController,
  now: () => number = Date.now,
): DeadlineHandle => {
  const deadlineAt = resolveDeadlineAt(options, now());
  if (deadlineAt === null) {
    return { deadlineAt: null, expired: () => false, cancel: () => {} };
  }

  let fired = false;
  const timer = setTimeout(
    () => {
      fired = true;
      if (!abortController.signal.aborted) abortController.abort(DEADLINE_ABORT_REASON);
    },
    Math.max(0, deadlineAt - now()),
  );
  // Never keep a worker process alive just to watch a 24h deadline.
  timer.unref?.();

  return {
    deadlineAt,
    expired: () => fired || now() >= deadlineAt,
    cancel: () => {
      clearTimeout(timer);
    },
  };
};
