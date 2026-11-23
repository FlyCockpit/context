import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

// The real tool list reaches the database; these tests register their own.
vi.mock("./tools", () => ({ registerMcpTools: () => {} }));

const { createMcpTransport } = await import("./handler");
const { STREAM_KEEPALIVE_MS } = await import("../stream-keepalive");

const MODERN_VERSION = "2026-07-28";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

type McpCall = { headers: Record<string, string>; body: Record<string, unknown> };

/** A `tools/call` of the 2026-07-28 per-request protocol (the modern leg). */
function modernCall(name: string): McpCall {
  return {
    headers: {
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: {}, _meta: MODERN_META },
    },
  };
}

/** A 2025-era stateless `tools/call` (the legacy leg). */
function legacyCall(name: string): McpCall {
  return {
    headers: {},
    body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } },
  };
}

/** A tool that stays silent (no progress, no log) until `release()`. */
function silentTool() {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const register = (server: McpServer) => {
    server.registerTool("silent", { description: "waits without a word" }, async () => {
      await done;
      return { content: [{ type: "text", text: "finished" }] };
    });
  };
  return { register, release: () => release() };
}

function request(call: McpCall, url = "http://internal/mcp") {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...call.headers,
    },
    body: JSON.stringify(call.body),
  });
}

/** `promise`, or a rejection once `ms` pass: a stalled stream fails the test and reaches its cleanup. */
function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no progress within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Reads until `predicate` holds or the stream ends; the whole read is bounded by `ms`. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  ms = 3_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  const decoder = new TextDecoder();
  let text = "";
  while (!predicate(text)) {
    const { value, done } = await within(reader.read(), Math.max(0, deadline - Date.now()));
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const keepalives = (text: string) => text.split(": keepalive\n\n").length - 1;

describe("the /mcp transport keeps a silent tool call alive", () => {
  it("pins a keepalive well under a 100 s proxy idle limit", () => {
    expect(STREAM_KEEPALIVE_MS).toBeGreaterThan(0);
    expect(STREAM_KEEPALIVE_MS * 3).toBeLessThan(100_000);
  });

  for (const [leg, call] of [
    ["modern", modernCall("silent")],
    ["legacy", legacyCall("silent")],
  ] as const) {
    it(`streams headers at once and keepalive comments until the result (${leg} leg)`, async () => {
      const tool = silentTool();
      const transport = createMcpTransport({ registerTools: tool.register, keepAliveMs: 20 });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        // Resolves while the tool is still waiting: the headers are out.
        const response = await within(transport.fetch(request(call)));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        if (!response.body) throw new Error("no streamed body");
        reader = response.body.getReader();
        const early = await readUntil(reader, (text) => keepalives(text) >= 2);
        expect(keepalives(early)).toBeGreaterThanOrEqual(2);
        expect(early).not.toContain("finished");
        tool.release();
        const rest = await readUntil(reader, () => false);
        expect(rest).toContain('"text":"finished"');
      } finally {
        tool.release();
        await reader?.cancel().catch(() => {});
        await transport.close();
      }
    });
  }

  it("still answers a notification with an empty 202", async () => {
    const transport = createMcpTransport({ registerTools: () => {}, keepAliveMs: 20 });
    try {
      const response = await transport.fetch(
        request({
          headers: { "mcp-protocol-version": MODERN_VERSION },
          body: {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 1, _meta: MODERN_META },
          },
        }),
      );
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    } finally {
      await transport.close();
    }
  });
});

// ── under a proxy's idle limit ──

// A proxy such as Cloudflare ends an exchange whose origin sends nothing for
// its read timeout. Unit tests may not open sockets (scripts/test-io-guard.ts),
// so the limit is modelled in process: from dispatch to the result, the
// headers and every later chunk must each arrive within the idle window, or
// the "proxy" gives up. The scaled windows leave room for a loaded CI worker:
// a keepalive every 100 ms against a 1 s limit, a tool silent for 3 s.
const PROXY_IDLE_MS = 1_000;
const SILENT_MS = 3_000;

async function callUnderIdleLimit(keepAliveMs: number): Promise<string> {
  const tool = silentTool();
  const transport = createMcpTransport({ registerTools: tool.register, keepAliveMs });
  const release = setTimeout(tool.release, SILENT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await within(transport.fetch(request(modernCall("silent"))), PROXY_IDLE_MS);
    if (!response.body) throw new Error("no streamed body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The idle window bounds each chunk; the call as a whole gets 10 s.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const left = deadline - Date.now();
      const { value, done } = await within(
        reader.read(),
        Math.max(0, Math.min(PROXY_IDLE_MS, left)),
      );
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(release);
    tool.release();
    await reader?.cancel().catch(() => {});
    await transport.close();
  }
}

describe("a silent tool call under a proxy's idle limit", () => {
  it("completes when the keepalive beats the idle limit", async () => {
    expect(await callUnderIdleLimit(100)).toContain('"text":"finished"');
  }, 15_000);

  it("is cut without a keepalive (the failure this guards against)", async () => {
    // 0 turns the SDK's keepalive off.
    await expect(callUnderIdleLimit(0)).rejects.toThrow(/no progress within 1000 ms/);
  }, 15_000);
});
