/**
 * How many `delegate_explore` helpers one investigation may run. The run
 * engine maps COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS and COCKPIT_CONTEXT_MAX_HELPERS
 * onto these; the defaults equal the env defaults.
 */

/** Helpers running at once across the whole run (COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS default). */
export const DEFAULT_MAX_PARALLEL_HELPERS = 5;
/** Helpers one run may start across all its `delegate_explore` calls (COCKPIT_CONTEXT_MAX_HELPERS default). */
export const DEFAULT_MAX_HELPERS = 10;
/** Fewest helpers one `delegate_explore` call asks for (fewer only when the limits are lower). */
const MIN_HELPERS_PER_DELEGATION = 2;

export type HelperLimits = {
  /** Helpers running at once across the run; never above `maxHelpers`. */
  maxParallel: number;
  /** Helpers the run may start in total. */
  maxHelpers: number;
  /** Briefs one call must pass. */
  minPerCall: number;
  /** Briefs one call may pass: the parallel limit, so one call never queues behind itself. */
  maxPerCall: number;
};

const positiveInt = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;

/** Normalize the options: positive integers, and the parallel limit clamped to the total. */
export function resolveHelperLimits(
  input: { maxParallelHelpers?: number; maxHelpers?: number } = {},
): HelperLimits {
  const maxHelpers = positiveInt(input.maxHelpers, DEFAULT_MAX_HELPERS);
  const maxParallel = Math.min(
    maxHelpers,
    positiveInt(input.maxParallelHelpers, DEFAULT_MAX_PARALLEL_HELPERS),
  );
  return {
    maxParallel,
    maxHelpers,
    minPerCall: Math.min(MIN_HELPERS_PER_DELEGATION, maxParallel),
    maxPerCall: maxParallel,
  };
}

/** "2–5", or "2" when both bounds are equal. */
export function formatPerCallRange(limits: HelperLimits): string {
  return limits.minPerCall === limits.maxPerCall
    ? String(limits.maxPerCall)
    : `${limits.minPerCall}–${limits.maxPerCall}`;
}
