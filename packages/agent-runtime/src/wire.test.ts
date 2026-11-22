import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_MAX_OUTPUT_TOKENS } from "./adapters";
import { runAgentLoop } from "./loop";
import type { AgentLoopOptions, AgentUsage, ModelApi } from "./types";

// The real adapters and the real `chat()`, with only `fetch` replaced: what these tests
// read is the request body each SDK actually sends and the usage the loop reports from
// the response it actually parses. Unit tests of adapters.ts check the options it builds;
// only this level shows whether a provider ever sees them.

type Sent = { url: string; body: Record<string, unknown> };

/**
 * An SSE body. OpenAI-style streams end in `[DONE]`; Anthropic's name each event
 * (`event: message_start`) and end at `message_stop`.
 */
const sse = (events: unknown[], headers: Record<string, string> = {}, named = false): Response => {
  const text = events
    .map((event) => {
      const name = named ? `event: ${(event as { type: string }).type}\n` : "";
      return `${name}data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(named ? text : `${text}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
};

/** {@link sse} in the API's own framing. */
const answer = (api: ModelApi, id: string, headers: Record<string, string> = {}) =>
  sse(answers[api](id), headers, api === "messages");

/** One streamed text answer, with OpenRouter's `usage.cost`, in each API's wire format. */
const answers: Record<ModelApi, (id: string) => unknown[]> = {
  "chat-completions": (id) => {
    const chunk = { id, object: "chat.completion.chunk", created: 1, model: "m" };
    return [
      {
        ...chunk,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, cost: 0.000125 },
      },
    ];
  },
  responses: (id) => {
    const response = {
      id,
      object: "response",
      created_at: 1,
      model: "m",
      status: "in_progress",
      output: [],
      error: null,
      incomplete_details: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: null,
      top_p: null,
      metadata: {},
      instructions: null,
    };
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    return [
      { type: "response.created", sequence_number: 0, response },
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "ok",
        logprobs: [],
      },
      {
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item: message,
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: {
          ...response,
          status: "completed",
          output: [message],
          usage: {
            input_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 13,
            cost: 0.000125,
          },
        },
      },
    ];
  },
  messages: () => [
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2, cost: 0.000125 },
    },
    { type: "message_stop" },
  ],
};

const ceilingField: Record<ModelApi, string> = {
  "chat-completions": "max_completion_tokens",
  responses: "max_output_tokens",
  messages: "max_tokens",
};

const bodyText = async (input: unknown, init?: RequestInit): Promise<string> => {
  if (input instanceof Request) return input.clone().text();
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return new Response(body ?? null).text();
};

/** Replace `fetch`; each call gets the next scripted response. */
const stubFetch = (responses: Array<() => Response>): Sent[] => {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, body: JSON.parse(await bodyText(input, init)) });
    const next = responses[sent.length - 1];
    if (!next) throw new Error(`unexpected request ${sent.length} to ${url}`);
    return next();
  });
  return sent;
};

const run = async (api: ModelApi, overrides: Partial<AgentLoopOptions> = {}) => {
  const reports: AgentUsage[] = [];
  const result = await runAgentLoop({
    model: {
      api,
      model: api === "messages" ? "anthropic/claude-test" : "openai/test",
      apiKey: "test-key",
      baseUrl: "https://gateway.test/api/v1",
    },
    systemPrompt: "system",
    messages: [{ id: "u", role: "user", parts: [{ type: "text", content: "hi" }] }],
    tools: [],
    maxIterations: 2,
    onUsage: (usage) => {
      reports.push(usage);
    },
    ...overrides,
  });
  return { result, reports };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["chat-completions", "responses", "messages"] as const)("on the wire: %s", (api) => {
  it("sends the per-turn output ceiling in the API's own field", async () => {
    const sent = stubFetch([() => answer(api, "gen-1", { "x-generation-id": "gen-1" })]);
    const { result } = await run(api);
    expect(result.stopReason).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body[ceilingField[api]]).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("sends a caller's ceiling, and none when the caller opts out", async () => {
    const sent = stubFetch([() => answer(api, "gen-1"), () => answer(api, "gen-2")]);
    await run(api, { maxOutputTokens: 777 });
    expect(sent[0]?.body[ceilingField[api]]).toBe(777);
    await run(api, { maxOutputTokens: null });
    // The Anthropic adapter must send max_tokens, so it falls back to its own default.
    if (api === "messages") expect(sent[1]?.body.max_tokens).not.toBe(777);
    else expect(sent[1]?.body).not.toHaveProperty(ceilingField[api]);
  });

  it("reports the generation id from the response header, with the billed cost", async () => {
    stubFetch([() => answer(api, "body-id", { "x-generation-id": "gen-header" })]);
    const { result, reports } = await run(api);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ costUsd: 0.000125, generationIds: ["gen-header"] });
    expect(result.usage.generationIds).toEqual(["gen-header"]);
  });
});

describe.each(["chat-completions", "responses"] as const)("on the wire: %s, no header", (api) => {
  it("falls back to the id in the body", async () => {
    stubFetch([() => answer(api, "gen-from-body")]);
    const { reports } = await run(api);
    expect(reports[0]?.generationIds).toEqual(["gen-from-body"]);
  });
});

/** A streamed answer cut off at the output ceiling, in each API's own way of saying so. */
const truncated: Record<ModelApi, (id: string) => unknown[]> = {
  "chat-completions": (id) => {
    const chunk = { id, object: "chat.completion.chunk", created: 1, model: "m" };
    return [
      {
        ...chunk,
        choices: [
          { index: 0, delta: { role: "assistant", content: "Rivers" }, finish_reason: null },
        ],
      },
      {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 25, completion_tokens: 40, total_tokens: 65, cost: 0.0000225 },
      },
    ];
  },
  responses: (id) => {
    const response = {
      id,
      object: "response",
      created_at: 1,
      model: "m",
      status: "in_progress",
      output: [],
      error: null,
      incomplete_details: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: null,
      top_p: null,
      metadata: {},
      instructions: null,
    };
    return [
      { type: "response.created", sequence_number: 0, response },
      {
        type: "response.incomplete",
        sequence_number: 1,
        response: {
          ...response,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 25,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 40 },
            total_tokens: 65,
            cost: 0.0000225,
          },
        },
      },
    ];
  },
  messages: () => [
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Rivers" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { output_tokens: 40, cost: 0.0000225 },
    },
    { type: "message_stop" },
  ],
};

describe.each(["chat-completions", "responses", "messages"] as const)(
  "on the wire: %s at the ceiling",
  (api) => {
    it("stops as output-truncated, once, with the cut-off call's cost and id", async () => {
      const sent = stubFetch([
        () => sse(truncated[api]("gen-cut"), { "x-generation-id": "gen-cut" }, api === "messages"),
        () => answer(api, "gen-retry"),
      ]);
      const { result, reports } = await run(api, { maxOutputTokens: 40 });
      expect(result.stopReason).toBe("output-truncated");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body[ceilingField[api]]).toBe(40);
      expect(reports).toEqual([
        expect.objectContaining({
          outputTokens: 40,
          costUsd: 0.0000225,
          generationIds: ["gen-cut"],
        }),
      ]);
    });
  },
);

describe("on the wire: chat-completions tool call cut off at the ceiling", () => {
  /** Tool-call deltas, then `finish_reason: "length"`, as a provider sends them. */
  const cutOff = (calls: Array<{ id: string; args: string }>) => {
    const chunk = { id: "gen-cut", object: "chat.completion.chunk", created: 1, model: "m" };
    return [
      ...calls.map((call, index) => ({
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: "lookup", arguments: call.args },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })),
      {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70, cost: 0.00003 },
      },
    ];
  };

  const lookup = (seen: unknown[]) => ({
    name: "lookup",
    description: "Look something up.",
    inputSchema: z.object({ q: z.string() }),
    maxResultChars: 1000,
    execute: (input: unknown) => {
      seen.push(input);
      return "found";
    },
  });

  for (const [label, calls] of [
    ["a call whose arguments were cut off", [{ id: "call_1", args: '{"q":"riv' }]],
    [
      "a complete call followed by a cut-off one",
      [
        { id: "call_1", args: '{"q":"a"}' },
        { id: "call_2", args: '{"q":"riv' },
      ],
    ],
  ] as const) {
    it(`stops as output-truncated after ${label}, without dispatching again`, async () => {
      const sent = stubFetch([
        () => sse(cutOff([...calls]), { "x-generation-id": "gen-cut" }),
        () => answer("chat-completions", "gen-next"),
      ]);
      const seen: unknown[] = [];
      const { result, reports } = await run("chat-completions", {
        tools: [lookup(seen)],
        maxIterations: 3,
      });
      expect(result.stopReason).toBe("output-truncated");
      expect(sent).toHaveLength(1);
      // The cut-off call never ran on half its arguments.
      expect(seen).not.toContainEqual({ q: "riv" });
      expect(reports).toEqual([
        expect.objectContaining({ costUsd: 0.00003, generationIds: ["gen-cut"] }),
      ]);
    });
  }
});

describe("on the wire: failed attempts", () => {
  it("keeps the id of an attempt that answered and then failed, with the retry's", async () => {
    // The first attempt answers 200 and then breaks off before any usage; the retry
    // succeeds. The first may still be billed, so its id is kept for the audit.
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("fetch failed"));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-generation-id": "gen-a" },
        },
      );
    stubFetch([broken, () => answer("chat-completions", "gen-b", { "x-generation-id": "gen-b" })]);
    const { result, reports } = await run("chat-completions");
    expect(result.stopReason).toBe("completed");
    // Each id is reported with its own call: the retry with its cost, the broken
    // attempt as the unpriced call it is.
    expect(reports).toEqual([
      expect.objectContaining({ costUsd: 0.000125, generationIds: ["gen-b"] }),
      expect.objectContaining({ unpricedCalls: 1, generationIds: ["gen-a"] }),
    ]);
    expect([...(result.usage.generationIds ?? [])].sort()).toEqual(["gen-a", "gen-b"]);
  });

  it("records no id for a refused request", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ error: { message: "not a valid model ID", code: 400 } }), {
          status: 400,
          headers: { "content-type": "application/json", "x-generation-id": "gen-refused" },
        }),
    ]);
    const reports: AgentUsage[] = [];
    await expect(
      run("chat-completions", { onUsage: (usage) => void reports.push(usage) }),
    ).rejects.toThrow(/not a valid model ID/);
    expect(reports.flatMap((usage) => usage.generationIds ?? [])).toEqual([]);
  });
});
