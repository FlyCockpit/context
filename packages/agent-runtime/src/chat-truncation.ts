import type { AnyTextAdapter, FetchWrapper, StreamChunk } from "@tanstack/ai";

import { collectFinishReasons, normalizeFinishReason } from "./finish-reason";
import { observeBody, parseWirePayload } from "./raw-usage";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a chat-completions payload says a choice stopped at the output ceiling. */
const payloadTruncated = (payload: unknown): boolean => {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  return payload.choices.some((choice) =>
    collectFinishReasons(choice).some((raw) => normalizeFinishReason(raw) === "length"),
  );
};

/**
 * The chat-completions adapter with a truncated tool call reported as truncated.
 *
 * `@tanstack/ai-openrouter`'s chat adapter reports `finishReason: "tool_calls"` whenever
 * it closed any tool call, even when the provider said `finish_reason: "length"`, and it
 * keeps no trace of the provider's reason. A turn cut off at the output ceiling in the
 * middle of a tool call's arguments would then run that call on half its input and
 * dispatch again. This wrapper reads the provider's own `finish_reason` (and
 * `native_finish_reason`) off the wire next to the adapter and restores `"length"` on the
 * `RUN_FINISHED` before `chat()` acts on it, so `chat()` treats the call as cut off and
 * the loop stops with `output-truncated`, as for every other API.
 */
export const withWireTruncation = (adapter: AnyTextAdapter): AnyTextAdapter => {
  const chatStream: AnyTextAdapter["chatStream"] = async function* (options) {
    let truncated = false;
    const sniff: FetchWrapper = (next) => async (input, init) => {
      truncated = false;
      return observeBody(await next(input, init), (text) => {
        if (truncated || !text.includes("finish_reason")) return;
        truncated = payloadTruncated(parseWirePayload(text));
      });
    };
    const wrapFetch: FetchWrapper = (next) =>
      options.wrapFetch ? options.wrapFetch(sniff(next)) : sniff(next);
    for await (const chunk of adapter.chatStream({ ...options, wrapFetch })) {
      if (chunk.type === "RUN_FINISHED" && truncated && chunk.finishReason !== "length") {
        const restored: StreamChunk = { ...chunk, finishReason: "length" };
        yield restored;
      } else {
        yield chunk;
      }
    }
  };
  // The same shape the retry adapter builds: the adapter's own fields, one stream method.
  return { ...adapter, model: adapter.model, chatStream } as AnyTextAdapter;
};
