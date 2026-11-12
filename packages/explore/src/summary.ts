import type { ExplorePackageInfo } from "./prompts";
import {
  deriveExploreBudgets,
  type ExploreAgentOptions,
  type ExploreAgentResult,
  runExploreAgent,
} from "./run-explore-agent";

/**
 * The overview prompt covers five points and asks the explore agent to confirm
 * paths with tools on a small budget instead of reading the whole tree.
 */
export function buildCheckoutSummaryPrompt(info: ExplorePackageInfo): string {
  const name = info.identifier;
  return `You are analyzing the repository for the package "${name}".
Provide a concise guide that will help future AI queries about this package be answered faster. Include:
1. What this package/library does (1-2 sentences)
2. The key source files and directories most relevant to understanding "${name}" — list specific paths
3. Main exports, entry points, or APIs that users of this package interact with
4. Important patterns, conventions, or architectural decisions in the codebase
5. Any configuration files or build setup relevant to this package
Start from the repo map, then confirm with a few targeted tool calls; only list paths you have seen in tool output. Your budget is small — do not try to read the whole tree.
Reply with only the guide text, no preamble or markdown headers.`;
}

export type CheckoutSummaryOptions = Omit<
  ExploreAgentOptions,
  "question" | "history" | "overview" | "overviewSource" | "takeSteeringMessages" | "package"
> & {
  package: ExplorePackageInfo;
  /** Iteration budget; defaults to `deriveExploreBudgets().summaryMaxIterations` (30). */
  maxIterations?: number;
  /** Wall-clock budget; defaults to `deriveExploreBudgets().summaryTimeoutMs` (300 s). */
  timeoutMs?: number;
};

export type CheckoutSummaryResult = ExploreAgentResult & {
  /** The overview text to store on the checkout (empty when the model wrote none). */
  summary: string;
};

/**
 * Generate a checkout's model-written overview: one explore run with the
 * overview prompt at a reduced budget (no delegation by default, no existing
 * overview in the prompt). The result is fenced as untrusted wherever it is
 * injected later (`buildExploreSystemPrompt`), because it was written by a
 * model reading the dependency.
 *
 * Budgets: pass `maxIterations` / `timeoutMs` directly, or derive them from the
 * run budgets with `deriveExploreBudgets({ maxIterations, timeoutMs })`.
 */
export async function generateCheckoutSummary(
  options: CheckoutSummaryOptions,
): Promise<CheckoutSummaryResult> {
  const defaults = deriveExploreBudgets();
  const result = await runExploreAgent({
    ...options,
    question: buildCheckoutSummaryPrompt(options.package),
    allowDelegation: options.allowDelegation ?? false,
    maxIterations: options.maxIterations ?? defaults.summaryMaxIterations,
    timeoutMs: options.timeoutMs ?? defaults.summaryTimeoutMs,
  });
  return { ...result, summary: result.answer };
}
