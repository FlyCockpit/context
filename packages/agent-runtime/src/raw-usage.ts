import type { FetchWrapper } from "@tanstack/ai";

/**
 * Usage fields read straight off the provider's wire payload.
 *
 * Each adapter normalizes usage its own way, and two of them drop fields Cockpit Context bills and
 * reports on: the OpenRouter responses adapter keeps cache reads but not
 * `input_tokens_details.cache_write_tokens`, and the Anthropic messages adapter has no
 * notion of OpenRouter's `usage.cost`. The loop fills those gaps from here; a value the
 * adapter did report always wins.
 */
export interface RawUsage {
  /** OpenRouter's billed cost in USD (`usage.cost`). */
  costUsd?: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The usage object of one wire payload: a chat-completions chunk (`usage`), a Responses
 * event (`response.usage`) or an Anthropic Messages event (`usage`, `message.usage`).
 */
export const extractRawUsage = (payload: unknown): RawUsage | undefined => {
  if (!isRecord(payload)) return undefined;
  const usage = [payload.usage, isRecord(payload.response) ? payload.response.usage : undefined]
    .concat(isRecord(payload.message) ? [payload.message.usage] : [])
    .find(isRecord);
  if (!usage) return undefined;

  const details = [usage.prompt_tokens_details, usage.input_tokens_details].find(isRecord);
  const costUsd = finite(usage.cost);
  const cacheWriteTokens =
    finite(usage.cache_creation_input_tokens) ?? finite(details?.cache_write_tokens);
  const raw: RawUsage = {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
  return Object.keys(raw).length > 0 ? raw : undefined;
};

/**
 * The provider's id for one answered model call, from a wire payload: a chat-completions
 * chunk (`id`), a Responses event (`response.id`) or an Anthropic Messages event
 * (`message.id`). OpenRouter's `GET /api/v1/generation?id=` takes the first two; for
 * messages it returns a `msg_…` id that endpoint refuses, which is why the
 * `x-generation-id` response header wins whenever it is present.
 */
export const extractPayloadId = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  const id = [
    payload.id,
    isRecord(payload.response) ? payload.response.id : undefined,
    isRecord(payload.message) ? payload.message.id : undefined,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  return id;
};

/** The response header OpenRouter puts its generation id in, on every API. */
const GENERATION_ID_HEADER = "x-generation-id";

/** One wire payload line: an SSE `data:` line or a whole JSON body, parsed. */
export const parseWirePayload = (text: string): unknown => {
  const json = text.startsWith("data:") ? text.slice("data:".length).trim() : text;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/**
 * `response` with its body passed through unchanged, calling `onText` with each SSE
 * line (trimmed) as the reader receives it, or with the whole body once it ends when
 * the response is not a stream. The callback runs before the chunk that completes the
 * line reaches the reader, so whatever it records is known by the time the adapter
 * acts on that line.
 */
export const observeBody = (response: Response, onText: (text: string) => void): Response => {
  if (!response.body) return response;
  const streaming = (response.headers.get("content-type") ?? "").includes("event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      if (!streaming) return;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onText(line.trim());
    },
    flush() {
      buffer += decoder.decode();
      onText(buffer.trim());
    },
  });
  return new Response(response.body.pipeThrough(tap), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * A `chat({ wrapFetch })` wrapper that watches the response body as the adapter reads it and
 * keeps the last usage it saw ({@link observeBody}): by the time the loop sees
 * `RUN_FINISHED`, {@link UsageTap.latest} is final.
 *
 * It also keeps one generation id per answered attempt (the `x-generation-id` header,
 * else the first payload id), so a recorded cost can be checked call by call against
 * the provider's own records.
 *
 * Only lines that mention `"usage"` (or `"id"`, until the attempt's id is known) are
 * parsed, so the per-chunk cost is a substring scan. A non-streaming JSON body is parsed
 * once, when it ends.
 */
export interface UsageTap {
  wrap: FetchWrapper;
  /** The usage of the most recent model call, if its body carried any. */
  latest: () => RawUsage | undefined;
  /** Attempts of this dispatch that got a successful response: the provider may bill each. */
  answered: () => number;
  /**
   * The most recent attempt's generation id, if it has one not handed out yet: the id
   * that belongs with the usage that attempt reports, whether it finished or failed.
   */
  takeLatestGenerationId: () => string | undefined;
  /** Every generation id not handed out yet, in attempt order (attempts that never reported). */
  takeGenerationIds: () => string[];
}

export const createUsageTap = (): UsageTap => {
  let latest: RawUsage | undefined;
  let answered = 0;
  let attempts = 0;
  /** Ids not handed out yet, by attempt number. */
  const pendingIds = new Map<number, string>();

  const wrap: FetchWrapper = (next) => async (input, init) => {
    // One tap serves one dispatch, but a retried dispatch calls fetch again: only the
    // attempt that answered may report.
    latest = undefined;
    attempts += 1;
    const attempt = attempts;
    const response = await next(input, init);
    if (response.ok) answered += 1;
    // Only an answered attempt can be billed, so only it gets an id.
    let needsId = response.ok;
    const keepId = (id: string | undefined) => {
      if (!needsId || !id) return;
      needsId = false;
      pendingIds.set(attempt, id);
    };
    keepId(response.headers.get(GENERATION_ID_HEADER)?.trim() || undefined);

    return observeBody(response, (text) => {
      const hasUsage = text.includes('"usage"');
      if (!hasUsage && !(needsId && text.includes('"id"'))) return;
      const payload = parseWirePayload(text);
      if (payload === undefined) return;
      keepId(extractPayloadId(payload));
      const usage = hasUsage ? extractRawUsage(payload) : undefined;
      // Merge: Anthropic splits usage across `message_start` and `message_delta`.
      if (usage) latest = { ...latest, ...usage };
    });
  };

  const takeLatestGenerationId = () => {
    const id = pendingIds.get(attempts);
    pendingIds.delete(attempts);
    return id;
  };

  const takeGenerationIds = () => {
    // A Map iterates in insertion order, which is attempt order.
    const ids = [...pendingIds.values()];
    pendingIds.clear();
    return ids;
  };

  return {
    wrap,
    latest: () => latest,
    answered: () => answered,
    takeLatestGenerationId,
    takeGenerationIds,
  };
};
