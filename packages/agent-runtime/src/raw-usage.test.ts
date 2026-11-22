import { describe, expect, it } from "vitest";

import { createUsageTap, extractPayloadId, extractRawUsage } from "./raw-usage";

describe("extractRawUsage", () => {
  it("reads a chat-completions chunk", () => {
    expect(
      extractRawUsage({
        usage: { cost: 0.002, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 9 } },
      }),
    ).toEqual({ costUsd: 0.002, cacheWriteTokens: 9 });
  });

  it("reads a Responses `response.completed` event", () => {
    expect(
      extractRawUsage({
        type: "response.completed",
        response: { usage: { cost: 0.001, input_tokens_details: { cache_write_tokens: 3658 } } },
      }),
    ).toEqual({ costUsd: 0.001, cacheWriteTokens: 3658 });
  });

  it("reads Anthropic `message_start` and `message_delta` events", () => {
    expect(
      extractRawUsage({
        type: "message_start",
        message: { usage: { cache_creation_input_tokens: 7 } },
      }),
    ).toEqual({ cacheWriteTokens: 7 });
    expect(
      extractRawUsage({ type: "message_delta", usage: { output_tokens: 3, cost: 0.5 } }),
    ).toEqual({ costUsd: 0.5 });
  });

  it("returns undefined without usage, or with nothing it tracks", () => {
    expect(extractRawUsage({ choices: [] })).toBeUndefined();
    expect(extractRawUsage({ usage: { prompt_tokens: 1 } })).toBeUndefined();
    expect(extractRawUsage(null)).toBeUndefined();
  });
});

const sse = (events: unknown[], split = 7): Response => {
  const text =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  // Odd-sized chunks, so a line spans chunk boundaries.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};

describe("createUsageTap", () => {
  it("passes the body through unchanged and merges usage across events", async () => {
    const events = [
      { type: "message_start", message: { usage: { cache_creation_input_tokens: 12 } } },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 2, cost: 0.25 } },
    ];
    const tap = createUsageTap();
    const fetchFn = tap.wrap(async () => sse(events));
    const response = await fetchFn("https://example.test");
    const text = await response.text();
    expect(text).toContain('"text":"hi"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(tap.latest()).toEqual({ cacheWriteTokens: 12, costUsd: 0.25 });
  });

  it("records an event's usage before the reader receives the chunk that ends it", async () => {
    const tap = createUsageTap();
    const response = await tap.wrap(async () => sse([{ usage: { cost: 1 } }], 4096))("x");
    const reader = response.body!.getReader();
    await reader.read();
    expect(tap.latest()).toEqual({ costUsd: 1 });
  });

  it("parses a non-streaming JSON body when it ends", async () => {
    const tap = createUsageTap();
    const body = JSON.stringify(
      { usage: { cost: 0.1, prompt_tokens_details: { cache_write_tokens: 4 } } },
      null,
      2,
    );
    const response = await tap.wrap(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    )("x");
    expect(await response.json()).toEqual(JSON.parse(body));
    expect(tap.latest()).toEqual({ costUsd: 0.1, cacheWriteTokens: 4 });
  });

  it("forgets a failed attempt's usage when the dispatch fetches again", async () => {
    const tap = createUsageTap();
    let call = 0;
    const fetchFn = tap.wrap(async () => (call++ === 0 ? sse([{ usage: { cost: 9 } }]) : sse([])));
    await (await fetchFn("x")).text();
    expect(tap.latest()).toEqual({ costUsd: 9 });
    await (await fetchFn("x")).text();
    expect(tap.latest()).toBeUndefined();
  });

  it("counts the attempts of the dispatch that got a successful response", async () => {
    const tap = createUsageTap();
    expect(tap.answered()).toBe(0);
    await tap.wrap(async () => new Response("busy", { status: 503 }))("x");
    expect(tap.answered()).toBe(0);
    await tap.wrap(async () => sse([]))("x");
    await tap.wrap(async () => sse([]))("x");
    expect(tap.answered()).toBe(2);
  });
});

describe("extractPayloadId", () => {
  it("reads the id of a chat chunk, a Responses event and a Messages event", () => {
    expect(extractPayloadId({ id: "gen-1", choices: [] })).toBe("gen-1");
    expect(extractPayloadId({ type: "response.created", response: { id: "gen-2" } })).toBe("gen-2");
    expect(extractPayloadId({ type: "message_start", message: { id: "msg_1" } })).toBe("msg_1");
    expect(extractPayloadId({ id: 7 })).toBeUndefined();
    expect(extractPayloadId({ id: "" })).toBeUndefined();
    expect(extractPayloadId("gen-3")).toBeUndefined();
  });
});

describe("createUsageTap generation ids", () => {
  const withHeader = (response: Response, id: string): Response => {
    const headers = new Headers(response.headers);
    headers.set("x-generation-id", id);
    return new Response(response.body, { status: response.status, headers });
  };

  it("prefers the x-generation-id header over the body's id", async () => {
    const tap = createUsageTap();
    const response = await tap.wrap(async () =>
      withHeader(sse([{ type: "message_start", message: { id: "msg_1" } }]), "gen-h"),
    )("x");
    await response.text();
    expect(tap.takeGenerationIds()).toEqual(["gen-h"]);
  });

  it("falls back to the first payload id, once per attempt, across chunk boundaries", async () => {
    const tap = createUsageTap();
    const fetchFn = tap.wrap(async () =>
      sse([
        { id: "gen-first", choices: [] },
        { id: "gen-other", choices: [], usage: { cost: 1 } },
      ]),
    );
    await (await fetchFn("x")).text();
    expect(tap.takeGenerationIds()).toEqual(["gen-first"]);
    expect(tap.latest()).toEqual({ costUsd: 1 });
  });

  it("reads the id of a non-streaming JSON body", async () => {
    const tap = createUsageTap();
    const body = JSON.stringify({ id: "gen-json", choices: [] });
    const response = await tap.wrap(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    )("x");
    await response.text();
    expect(tap.takeGenerationIds()).toEqual(["gen-json"]);
  });

  it("hands each id out once, in attempt order, and none for a refused attempt", async () => {
    const tap = createUsageTap();
    let call = 0;
    const fetchFn = tap.wrap(async () => {
      call += 1;
      if (call === 1) return withHeader(new Response("busy", { status: 503 }), "gen-refused");
      return withHeader(sse([]), `gen-${call}`);
    });
    await (await fetchFn("x")).text();
    await (await fetchFn("x")).text();
    await (await fetchFn("x")).text();
    expect(tap.takeGenerationIds()).toEqual(["gen-2", "gen-3"]);
    expect(tap.takeGenerationIds()).toEqual([]);
  });
});

describe("createUsageTap per-attempt ids", () => {
  it("hands out the latest attempt's id on its own, leaving earlier ones pending", async () => {
    const tap = createUsageTap();
    let call = 0;
    const fetchFn = tap.wrap(async () => {
      call += 1;
      const headers = new Headers({ "content-type": "text/event-stream" });
      headers.set("x-generation-id", `gen-${call}`);
      return new Response("data: {}\n\n", { headers });
    });
    await (await fetchFn("x")).text();
    await (await fetchFn("x")).text();
    expect(tap.takeLatestGenerationId()).toBe("gen-2");
    expect(tap.takeLatestGenerationId()).toBeUndefined();
    expect(tap.takeGenerationIds()).toEqual(["gen-1"]);
  });
});
