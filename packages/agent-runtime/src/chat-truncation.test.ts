import type { AnyTextAdapter, FetchWrapper, StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { withWireTruncation } from "./chat-truncation";

const sse = (payloads: unknown[]): Response =>
  new Response(
    `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** A stand-in adapter: fetches through `wrapFetch` like the SDK does, then reports `finishReason`. */
const fakeAdapter = (body: () => Response, finishReason: string): AnyTextAdapter =>
  ({
    name: "fake",
    model: "m",
    async *chatStream(options: { wrapFetch?: FetchWrapper }) {
      const fetchFn = options.wrapFetch
        ? options.wrapFetch(async () => body())
        : async () => body();
      await (await fetchFn("https://gateway.test/chat/completions")).text();
      yield { type: "RUN_FINISHED", runId: "r", threadId: "t", finishReason } as StreamChunk;
    },
  }) as unknown as AnyTextAdapter;

const finishOf = async (adapter: AnyTextAdapter, options: Record<string, unknown> = {}) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream(
    options as unknown as Parameters<AnyTextAdapter["chatStream"]>[0],
  )) {
    chunks.push(chunk);
  }
  return chunks.map((chunk) => (chunk as { finishReason?: string }).finishReason);
};

describe("withWireTruncation", () => {
  it("restores length when the adapter turned a cut-off tool call into tool_calls", async () => {
    const adapter = withWireTruncation(
      fakeAdapter(
        () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }]),
        "tool_calls",
      ),
    );
    expect(await finishOf(adapter)).toEqual(["length"]);
  });

  it("reads the provider's native reason too", async () => {
    const adapter = withWireTruncation(
      fakeAdapter(
        () =>
          sse([
            {
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "tool_calls",
                  native_finish_reason: "MAX_TOKENS",
                },
              ],
            },
          ]),
        "tool_calls",
      ),
    );
    expect(await finishOf(adapter)).toEqual(["length"]);
  });

  it("leaves a turn the provider finished on its own alone", async () => {
    const adapter = withWireTruncation(
      fakeAdapter(
        () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]),
        "tool_calls",
      ),
    );
    expect(await finishOf(adapter)).toEqual(["tool_calls"]);
  });

  it("still runs the caller's own fetch wrapper around the request", async () => {
    let wrapped = 0;
    const callerWrap: FetchWrapper = (next) => async (input, init) => {
      wrapped += 1;
      return next(input, init);
    };
    const adapter = withWireTruncation(
      fakeAdapter(
        () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }]),
        "tool_calls",
      ),
    );
    expect(await finishOf(adapter, { wrapFetch: callerWrap })).toEqual(["length"]);
    expect(wrapped).toBe(1);
  });
});
