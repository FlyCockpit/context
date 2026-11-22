import type { AnyTextAdapter, PromptCacheOptions } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenRouterResponsesText, createOpenRouterText } from "@tanstack/ai-openrouter";

import { withWireTruncation } from "./chat-truncation";
import { messagesFetch } from "./messages-compat";
import type { AgentModel } from "./types";

type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];
type OpenRouterResponsesModel = Parameters<typeof createOpenRouterResponsesText>[0];
type AnthropicModel = Parameters<typeof createAnthropicChat>[0];

/** OpenRouter's API root, the default endpoint for every {@link AgentModel.api}. */
const DEFAULT_MODEL_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Claude models are the ones that need explicit cache breakpoints; OpenRouter names them
 * `anthropic/<model>`. Every other provider OpenRouter routes to caches the prompt prefix
 * automatically.
 */
const isAnthropicModel = (model: string): boolean => model.startsWith("anthropic/");

/**
 * The Anthropic SDK appends `/v1/messages` itself, so it takes the API root without the
 * trailing `/v1` that {@link AgentModel.baseUrl} carries. Throws on a base URL that does not
 * end in `/v1`: the request would otherwise go to `<base>/v1/messages`, a path no
 * OpenRouter-style gateway serves. `@cockpit-context/env` refuses such a value at boot.
 */
export const anthropicSdkBaseUrl = (baseUrl: string = DEFAULT_MODEL_BASE_URL): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!trimmed.endsWith("/v1")) {
    throw new Error(`The messages API needs a base URL that ends in /v1, got ${baseUrl}`);
  }
  return trimmed.slice(0, -"/v1".length);
};

/**
 * Explicit per-turn output ceiling, sent to every provider in its own field
 * (see {@link outputCeilingOptions}).
 *
 * Why it exists: without it the *provider* default governs the ceiling, and several
 * defaults are as low as 4096 — small enough that a single long structured tool call
 * gets cut off mid-JSON. That is exactly the failure the `"output-truncated"` stop
 * reason exists to catch, and the cheapest way to stop hitting it is to not sit on an
 * unknown default.
 *
 * Why this size: the worst realistic single emission is a tool call carrying a list of
 * 100-200 records. Each record serializes as roughly `{"name":"...","url":"https://..."}`
 * ≈ 30-50 tokens, so 200 records is ~10k tokens, plus tool-call framing and any preceding
 * prose. 16384 leaves ~1.6x headroom over that worst case while staying at or under the
 * per-response output cap of most models (a value above a model's own cap is rejected by
 * some providers), and an unused ceiling costs nothing — only emitted tokens are billed.
 * Raise it per-loop via `maxOutputTokens` if your tool schemas emit more than that.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * Resolve the per-turn output ceiling: an explicit override wins, `null` means "leave it
 * to the provider default" (debug escape hatch), and `undefined` gets the default above.
 */
export const resolveMaxOutputTokens = (override?: number | null): number | undefined => {
  if (override === null) return undefined;
  if (override === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isFinite(override) || override < 1) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.trunc(override);
};

/**
 * The `modelOptions` that carry the output ceiling for one API. `chat()` has no generic
 * output-ceiling option and no adapter reads one, so each adapter gets the field it
 * maps onto the wire:
 *
 * - chat-completions (`@tanstack/ai-openrouter`): `maxCompletionTokens` → `max_completion_tokens`.
 * - responses (`@tanstack/ai-openrouter`): `maxOutputTokens` → `max_output_tokens`.
 * - messages (`@tanstack/ai-anthropic`): `max_tokens`, which the adapter otherwise fills
 *   with the model's own maximum (64000 for an id it does not know).
 */
export const outputCeilingOptions = (
  api: AgentModel["api"],
  maxOutputTokens: number | undefined,
): Record<string, number> => {
  if (maxOutputTokens === undefined) return {};
  switch (api) {
    case "chat-completions":
      return { maxCompletionTokens: maxOutputTokens };
    case "responses":
      return { maxOutputTokens };
    case "messages":
      return { max_tokens: maxOutputTokens };
  }
};

/** Prompt-caching wiring the caller wants attached to the adapter for this loop. */
export interface AdapterCacheOptions {
  /** Whether caching wiring should be attached at all (debug off-switch). */
  enabled: boolean;
  /** Stable prefix-cache key, shared by sibling requests (see `AgentLoopOptions.cacheKey`). */
  cacheKey?: string;
}

/**
 * The `chat({ promptCache })` value for a loop. The chat-completions and messages adapters
 * act on it themselves:
 *
 * - chat-completions (`@tanstack/ai-openrouter`): the key becomes OpenRouter's `session_id`,
 *   which keeps a session on one provider so its cache stays warm, and `anthropic/*` models
 *   get `cache_control` breakpoints on the system prompt, the last tool and the last message.
 * - messages (`@tanstack/ai-anthropic`): breakpoints on the last tool, the last user message
 *   (a tool result, mid-loop) and the system prompt.
 *
 * The breakpoint on the conversation tail is what makes an agent loop cheap: each dispatch
 * reads the previous dispatch's whole prefix from the cache and writes only the new turns.
 * `'none'` turns all of it off. The responses adapter ignores `promptCache`; see
 * {@link createModelAdapter} for its wiring.
 */
export const resolvePromptCache = (cache?: AdapterCacheOptions): PromptCacheOptions => {
  if (cache?.enabled === false) return "none";
  return cache?.cacheKey ? { retention: "short", key: cache.cacheKey } : "short";
};

/** OpenAI rejects a `prompt_cache_key` over 64 characters. Cut by code point, not unit. */
const clampCacheKey = (key: string): string => Array.from(key).slice(0, 64).join("");

/**
 * A provider adapter plus the provider options to forward to `chat({ modelOptions })`.
 * Keeping `modelOptions` here lets `tanstack-loop.ts` stay provider-agnostic — it only
 * forwards whatever this module produced.
 */
export interface ModelAdapter {
  adapter: AnyTextAdapter;
  modelOptions?: Record<string, unknown>;
}

/**
 * The adapter for one model, plus its `modelOptions`. `maxOutputTokens` is the resolved
 * per-turn ceiling ({@link resolveMaxOutputTokens}); `undefined` leaves it to the provider.
 */
export const createModelAdapter = (
  model: AgentModel,
  cache?: AdapterCacheOptions,
  maxOutputTokens?: number,
): ModelAdapter => {
  const cachingEnabled = cache?.enabled ?? true;
  const ceiling = outputCeilingOptions(model.api, maxOutputTokens);
  const withOptions = (adapter: AnyTextAdapter, options: Record<string, unknown>): ModelAdapter =>
    Object.keys(options).length > 0 ? { adapter, modelOptions: options } : { adapter };
  // Retries belong to retry-adapter.ts, which knows when a stream is committed and fails
  // over between models. Both SDKs retry on their own by default — the OpenRouter SDK
  // backs off on every 5xx for up to an hour — which would hide a failure from it until
  // the run's wall-clock deadline. So each SDK's own retries are off.
  const openRouterConfig = {
    retryConfig: { strategy: "none" as const },
    ...(model.baseUrl ? { serverURL: model.baseUrl } : {}),
  };
  switch (model.api) {
    case "chat-completions": {
      // A tool call cut off at the ceiling reads as one (chat-truncation.ts).
      const adapter = withWireTruncation(
        createOpenRouterText(model.model as OpenRouterModel, model.apiKey, openRouterConfig),
      );
      return withOptions(adapter, ceiling);
    }
    case "responses": {
      const adapter = createOpenRouterResponsesText(
        model.model as OpenRouterResponsesModel,
        model.apiKey,
        openRouterConfig,
      );
      if (!cachingEnabled) return withOptions(adapter, ceiling);
      // This adapter reads no `promptCache`, so the same wiring goes in by hand.
      // OpenRouter's Responses endpoint drops `cache_control` on content blocks; the
      // top-level one is Anthropic's automatic caching, which puts the breakpoint on the
      // last cacheable block of every request (the growing conversation tail).
      // `session_id` keeps the session on one provider; `prompt_cache_key` routes OpenAI
      // requests to the same cache shard.
      return withOptions(adapter, {
        ...ceiling,
        ...(cache?.cacheKey
          ? { sessionId: cache.cacheKey, promptCacheKey: clampCacheKey(cache.cacheKey) }
          : {}),
        ...(isAnthropicModel(model.model) ? { cacheControl: { type: "ephemeral" } } : {}),
      });
    }
    case "messages": {
      const adapter = createAnthropicChat(model.model as AnthropicModel, model.apiKey, {
        baseURL: anthropicSdkBaseUrl(model.baseUrl),
        maxRetries: 0,
        fetch: messagesFetch(),
      });
      return withOptions(adapter, ceiling);
    }
  }
};
