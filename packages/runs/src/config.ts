import type { ModelApi } from "@cockpit-context/agent-runtime";
import { COCKPIT_CONTEXT_HELPER_MODEL, env } from "@cockpit-context/env/server";

/**
 * Everything the run engine reads from the environment, read once per engine
 * (`loadRunConfig`) so the engine itself and its tests never touch env.
 */
export interface RunConfig {
  /** OPENROUTER_API_KEY. Without it (or a model) runs fail with MODEL_NOT_CONFIGURED. */
  apiKey: string | undefined;
  /** COCKPIT_CONTEXT_MODEL: the master agent's OpenRouter model id. No default. */
  model: string | undefined;
  /** COCKPIT_CONTEXT_HELPER_MODEL, falling back to COCKPIT_CONTEXT_MODEL. */
  helperModel: string | undefined;
  /** COCKPIT_CONTEXT_MODEL_API: the API the agent speaks to the model endpoint. */
  modelApi: ModelApi;
  /** COCKPIT_CONTEXT_OPENROUTER_BASE_URL: API root override (the fake OpenRouter server, a gateway). */
  baseUrl: string | undefined;
  /** COCKPIT_CONTEXT_MAX_ITERATIONS. */
  maxIterations: number;
  /** COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS in ms; also the checkout lease length. */
  runTimeoutMs: number;
  /** COCKPIT_CONTEXT_MODEL_STALL_SECONDS in ms: longest a model request may send nothing. */
  modelStallTimeoutMs: number;
  /** COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS. */
  maxConcurrentRuns: number;
  /** COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER. */
  maxConcurrentRunsPerUser: number;
  /**
   * COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER: main runs of one owner waiting
   * for a slot (preparing or queued) at once; past it a new run is refused
   * with BUSY. 0 or omitted = unlimited. Summary runs never count.
   */
  maxQueuedRunsPerUser?: number;
  /**
   * Summary runs live at once (waiting or running), JOBS_CONCURRENCY. A
   * `checkout.summarize` job returns once its run is started, so this keeps
   * the bound the job runner's slots used to give: at most this many
   * summaries ever compete with questions for the global slots.
   */
  maxConcurrentSummaries: number;
  /** COCKPIT_CONTEXT_LSP_MAX_SERVERS (0 disables the LSP tools). */
  lspMaxServers: number;
  /** COCKPIT_CONTEXT_LSP_IDLE_SECONDS in ms. */
  lspIdleMs: number;
  /** COCKPIT_CONTEXT_LSP_SANDBOX: `required` (Landlock, else no LSP tools) or `off`. */
  lspSandbox: "required" | "off";
}

export function loadRunConfig(): RunConfig {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.COCKPIT_CONTEXT_MODEL,
    helperModel: COCKPIT_CONTEXT_HELPER_MODEL,
    modelApi: env.COCKPIT_CONTEXT_MODEL_API,
    baseUrl: env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL,
    maxIterations: env.COCKPIT_CONTEXT_MAX_ITERATIONS,
    runTimeoutMs: env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS * 1_000,
    modelStallTimeoutMs: env.COCKPIT_CONTEXT_MODEL_STALL_SECONDS * 1_000,
    maxConcurrentRuns: env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS,
    maxConcurrentRunsPerUser: env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER,
    maxQueuedRunsPerUser: env.COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER,
    maxConcurrentSummaries: env.JOBS_CONCURRENCY,
    lspMaxServers: env.COCKPIT_CONTEXT_LSP_MAX_SERVERS,
    lspIdleMs: env.COCKPIT_CONTEXT_LSP_IDLE_SECONDS * 1_000,
    lspSandbox: env.COCKPIT_CONTEXT_LSP_SANDBOX,
  };
}
