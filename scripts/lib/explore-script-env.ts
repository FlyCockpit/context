/**
 * The environment the manual explore-agent scripts (`scripts/smoke-explore-agent.ts`,
 * `scripts/eval-explore-agent.ts`) honor, read in one place so both take the same
 * variables the server does (`packages/env/src/vars/server.ts`):
 *
 *   OPENROUTER_API_KEY, COCKPIT_CONTEXT_MODEL         required
 *   COCKPIT_CONTEXT_MODEL_API                         chat-completions (default) | responses | messages
 *   COCKPIT_CONTEXT_HELPER_MODEL                      defaults to the model
 *   COCKPIT_CONTEXT_OPENROUTER_BASE_URL               API root ending in /v1 (the fake server, a gateway)
 *   COCKPIT_CONTEXT_MAX_ITERATIONS                    positive integer
 *   COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS               positive integer
 *   COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS              positive integer
 *   COCKPIT_CONTEXT_MAX_HELPERS                       positive integer
 */

import type { ModelApi } from "../../packages/agent-runtime/src/index.ts";

const MODEL_APIS = [
  "chat-completions",
  "responses",
  "messages",
] as const satisfies readonly ModelApi[];

export type ExploreScriptEnv = {
  apiKey: string;
  model: string;
  api: ModelApi;
  helperModel?: string;
  baseUrl?: string;
  maxIterations?: number;
  timeoutSeconds?: number;
  maxParallelHelpers?: number;
  maxHelpers?: number;
};

const positiveInt = (raw: string | undefined): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const isModelApi = (value: string): value is ModelApi =>
  (MODEL_APIS as readonly string[]).includes(value);

/** The scripts' settings, or an error message naming what is missing or wrong. */
export function readExploreScriptEnv(
  env: NodeJS.ProcessEnv,
): { ok: true; value: ExploreScriptEnv } | { ok: false; error: string } {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model = env.COCKPIT_CONTEXT_MODEL?.trim();
  if (!apiKey || !model) {
    return { ok: false, error: "Set OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL." };
  }
  const api = env.COCKPIT_CONTEXT_MODEL_API?.trim() || "chat-completions";
  if (!isModelApi(api)) {
    return {
      ok: false,
      error: `COCKPIT_CONTEXT_MODEL_API must be one of ${MODEL_APIS.join(", ")}, got "${api}".`,
    };
  }
  const helperModel = env.COCKPIT_CONTEXT_HELPER_MODEL?.trim() || undefined;
  const baseUrl = env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL?.trim() || undefined;
  const maxIterations = positiveInt(env.COCKPIT_CONTEXT_MAX_ITERATIONS);
  const timeoutSeconds = positiveInt(env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS);
  const maxParallelHelpers = positiveInt(env.COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS);
  const maxHelpers = positiveInt(env.COCKPIT_CONTEXT_MAX_HELPERS);
  return {
    ok: true,
    value: {
      apiKey,
      model,
      api,
      ...(helperModel ? { helperModel } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(maxParallelHelpers !== undefined ? { maxParallelHelpers } : {}),
      ...(maxHelpers !== undefined ? { maxHelpers } : {}),
    },
  };
}
