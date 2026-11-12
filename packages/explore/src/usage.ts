import type { AgentUsage } from "@cockpit-context/agent-runtime";

export const ZERO_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Add two usage records. `costUsd` stays `undefined` only when neither side
 * reported one, so "the provider did not say" is distinguishable from "$0".
 */
export function sumUsage(a?: AgentUsage, b?: AgentUsage): AgentUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0),
    cacheCreationInputTokens:
      (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0),
    costUsd:
      a?.costUsd !== undefined || b?.costUsd !== undefined
        ? (a?.costUsd ?? 0) + (b?.costUsd ?? 0)
        : undefined,
    model: a?.model ?? b?.model,
  };
}

/**
 * Per-loop usage meter. The runtime reports usage per dispatch through
 * `onUsage`, and that is the number this trusts: a loop that ends by deadline
 * abort or a thrown model error returns zero usage in its result, but the
 * dispatches it already paid for were reported here as they finished. Falls
 * back to the result's own usage when no dispatch was observed (a stubbed loop).
 */
export class UsageMeter {
  private observed: AgentUsage = ZERO_USAGE;
  private dispatches = 0;

  /** `forward` also sees every dispatch (the run engine's live cost); its errors are logged. */
  constructor(private readonly forward?: (usage: AgentUsage) => void) {}

  readonly onUsage = (usage: AgentUsage): void => {
    this.observed = sumUsage(this.observed, usage);
    this.dispatches += 1;
    try {
      this.forward?.(usage);
    } catch (error) {
      console.warn("[explore] onUsage hook failed", error);
    }
  };

  /** Completed dispatches observed so far (the loop's iteration count). */
  get iterations(): number {
    return this.dispatches;
  }

  settle(resultUsage?: AgentUsage): AgentUsage {
    return this.dispatches > 0 ? this.observed : sumUsage(ZERO_USAGE, resultUsage);
  }
}
