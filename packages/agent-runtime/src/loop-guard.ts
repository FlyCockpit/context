/** Default consecutive identical executions allowed before the guard synthesizes an error. */
export const DEFAULT_LOOP_GUARD_THRESHOLD = 2;

/** Recursively sort object keys so semantically equal args hash identically. Arrays keep order. */
export function canonicalizeArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeArgs);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeArgs(record[key])]),
    );
  }
  return value;
}

export function callIdentity(toolName: string, args: unknown): string {
  return `${toolName}\0${JSON.stringify(canonicalizeArgs(args))}`;
}

/**
 * Build the fixed guard message for a repeated tool call. Stable bytes across
 * consecutive rejections of the same identity (dedup-friendly for prune).
 */
export function buildLoopGuardMessage(toolName: string, otherToolNames: string[]): string {
  const others =
    otherToolNames.length > 0 ? otherToolNames.join(", ") : "(no other tools available)";
  return (
    `Loop guard: tool "${toolName}" was called with identical arguments too many times in a row; ` +
    `the result would be the same. Do not re-issue this call. Other available tools: ${others}. ` +
    `Proceed with the information you already have, or try a different approach.`
  );
}

/**
 * Longest repeating cycle of *byte-identical* calls the guard will detect
 * (e.g. `A B A B A B`, `A B C A B C A B C`). Deliberately small: the longer the
 * window, the more a legitimately varied high-recall work pattern starts to look
 * like a cycle. Only exact-identity repetition in exact order counts, so a varied
 * re-query — the same search with a different `limit`/`tbs`/domain filter, or a
 * rotation of distinct queries — has different identities and can never match.
 */
export const MAX_CYCLE_PERIOD = 4;

/**
 * Build the guard message for a repeating cycle of distinct-but-identical calls.
 * Stable bytes for a given (toolName, period) so repeated rejections dedupe.
 */
export function buildLoopCycleGuardMessage(
  toolName: string,
  otherToolNames: string[],
  period: number,
): string {
  const others =
    otherToolNames.length > 0 ? otherToolNames.join(", ") : "(no other tools available)";
  return (
    `Loop guard: the last ${period} tool calls (ending with "${toolName}") have repeated as an ` +
    `identical cycle with identical arguments, so they cannot produce anything new. ` +
    `Do not re-issue this cycle. Other available tools: ${others}. Change your arguments ` +
    `substantively, try a different approach, or proceed with the information you already have.`
  );
}

/**
 * Per-loop tracker for repeated no-progress tool calls.
 *
 * Two rules, both keyed on the byte-identical `(toolName, canonicalized args)` identity:
 *
 * 1. **Consecutive identical calls.** Threshold is the number of *successful executions*
 *    of the same identity allowed before subsequent identical calls are blocked
 *    (default 2 → third back-to-back call guarded).
 * 2. **Short repeating cycles.** A cycle of up to {@link MAX_CYCLE_PERIOD} identities
 *    repeated `threshold + 1` times in exact order is blocked too (default: three full
 *    repetitions, so `A B A B A B` blocks on the sixth call). This is what catches a
 *    model that alternates between two identical calls forever — invisible to rule 1.
 *
 * Both rules require *exact* identity repetition, which is the property that keeps false
 * positives out: a genuinely varied sequence of calls (different queries, different
 * `limit`/`tbs`/domain filters, paging a stored result at different offsets) never
 * produces a repeating identity sequence, and is never blocked. That constraint is more
 * important than catching every possible loop shape — hence no "same identity seen N
 * times overall" rule: a repeat that is *not* adjacent may legitimately observe state
 * written by an intervening call (e.g. `list_records` after a `write_record`).
 */
export class LoopGuard {
  private lastIdentity: string | null = null;
  private consecutive = 0;
  private readonly threshold: number;
  private cachedMessage: string | null = null;
  /** Recent identities, newest last, capped at the longest detectable cycle window. */
  private readonly history: string[] = [];
  private readonly historyLimit: number;
  private readonly cachedCycleMessages = new Map<string, string>();

  constructor(threshold: number = DEFAULT_LOOP_GUARD_THRESHOLD) {
    // Clamp misconfiguration: at least 1 real execution before guarding.
    this.threshold = Number.isFinite(threshold)
      ? Math.max(1, Math.trunc(threshold))
      : DEFAULT_LOOP_GUARD_THRESHOLD;
    this.historyLimit = MAX_CYCLE_PERIOD * (this.threshold + 1);
  }

  /**
   * Decide whether to execute. When blocked, returns the synthesized message;
   * when allowed, returns null and the caller should execute the tool.
   */
  check(toolName: string, args: unknown, allToolNames: string[]): string | null {
    const identity = callIdentity(toolName, args);
    if (this.lastIdentity === identity) {
      this.consecutive += 1;
    } else {
      this.lastIdentity = identity;
      this.consecutive = 1;
      this.cachedMessage = null;
    }

    // Blocked calls are recorded too, so a cycle the model keeps re-issuing stays blocked.
    this.history.push(identity);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }

    if (this.consecutive > this.threshold) {
      if (this.cachedMessage === null) {
        const others = allToolNames.filter((name) => name !== toolName);
        this.cachedMessage = buildLoopGuardMessage(toolName, others);
      }
      return this.cachedMessage;
    }

    const cyclePeriod = this.detectCyclePeriod();
    if (cyclePeriod !== null) {
      const key = `${toolName}\0${cyclePeriod}`;
      const cached = this.cachedCycleMessages.get(key);
      if (cached !== undefined) return cached;
      const others = allToolNames.filter((name) => name !== toolName);
      const message = buildLoopCycleGuardMessage(toolName, others, cyclePeriod);
      this.cachedCycleMessages.set(key, message);
      return message;
    }

    return null;
  }

  /**
   * The shortest period `p` in `[2, MAX_CYCLE_PERIOD]` whose last-`p` block repeats
   * `threshold + 1` times in a row ending at the current call, or `null`. A block of a
   * single repeated identity is skipped — that is rule 1's job.
   */
  private detectCyclePeriod(): number | null {
    const repetitions = this.threshold + 1;
    for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
      const window = period * repetitions;
      if (this.history.length < window) continue;
      const tail = this.history.slice(this.history.length - window);
      const block = tail.slice(0, period);
      if (new Set(block).size < 2) continue;
      let matches = true;
      for (let index = period; index < window; index += 1) {
        if (tail[index] !== block[index % period]) {
          matches = false;
          break;
        }
      }
      if (matches) return period;
    }
    return null;
  }
}
