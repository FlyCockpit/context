import { describe, expect, it, vi } from "vitest";

import { messagesFetch, stripNullCacheControl } from "./messages-compat";

describe("stripNullCacheControl", () => {
  it("drops null markers from tools and system blocks and keeps real ones", () => {
    const body = {
      system: [{ type: "text", text: "s", cache_control: null }],
      tools: [
        { type: "custom", name: "a", cache_control: null },
        { type: "custom", name: "b", cache_control: { type: "ephemeral" } },
      ],
    };
    expect(stripNullCacheControl(body)).toBe(true);
    expect(body).toEqual({
      system: [{ type: "text", text: "s" }],
      tools: [
        { type: "custom", name: "a" },
        { type: "custom", name: "b", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("reports no change for a clean or unexpected body", () => {
    expect(stripNullCacheControl({ tools: [{ name: "a" }], system: "s" })).toBe(false);
    expect(stripNullCacheControl("nope")).toBe(false);
  });
});

describe("messagesFetch", () => {
  it("rewrites a JSON body that needs it and passes everything else through", async () => {
    const base = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("ok"));
    const send = messagesFetch(base as unknown as typeof fetch);

    await send("u", { method: "POST", body: JSON.stringify({ tools: [{ cache_control: null }] }) });
    expect(base.mock.calls[0]?.[1]).toEqual({ method: "POST", body: '{"tools":[{}]}' });

    const clean = { method: "POST", body: '{"tools":[]}' };
    await send("u", clean);
    expect(base.mock.calls[1]?.[1]).toBe(clean);

    await send("u", { body: "not json" });
    expect(base.mock.calls[2]?.[1]).toEqual({ body: "not json" });
  });
});
