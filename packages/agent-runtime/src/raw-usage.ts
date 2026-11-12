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
 * A `chat({ wrapFetch })` wrapper that watches the response body as the adapter reads it and
 * keeps the last usage it saw. The body passes through a `TransformStream` on the
 * adapter's own read path, so an event's usage is recorded before the adapter can act on
 * that event: by the time the loop sees `RUN_FINISHED`, {@link UsageTap.latest} is final.
 *
 * Only lines that mention `"usage"` are parsed, so the per-chunk cost is a substring scan.
 * A non-streaming JSON body is parsed once, when it ends.
 */
export interface UsageTap {
  wrap: FetchWrapper;
  /** The usage of the most recent model call, if its body carried any. */
  latest: () => RawUsage | undefined;
}

export const createUsageTap = (): UsageTap => {
  let latest: RawUsage | undefined;

  const record = (text: string) => {
    if (!text.includes('"usage"')) return;
    const json = text.startsWith("data:") ? text.slice("data:".length).trim() : text;
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    const usage = extractRawUsage(payload);
    // Merge: Anthropic splits usage across `message_start` and `message_delta`.
    if (usage) latest = { ...latest, ...usage };
  };

  const wrap: FetchWrapper = (next) => async (input, init) => {
    // One tap serves one dispatch, but a retried dispatch calls fetch again: only the
    // attempt that answered may report.
    latest = undefined;
    const response = await next(input, init);
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
        for (const line of lines) record(line.trim());
      },
      flush() {
        buffer += decoder.decode();
        record(buffer.trim());
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return { wrap, latest: () => latest };
};
