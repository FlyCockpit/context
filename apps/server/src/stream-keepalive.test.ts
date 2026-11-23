import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it } from "vitest";

import { RPC_EVENT_STREAM_OPTIONS, STREAM_KEEPALIVE_MS } from "./stream-keepalive";

/** `promise`, or a rejection once `ms` pass: a stalled stream fails the test and reaches its cleanup. */
function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no progress within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

describe("live-view stream keepalive", () => {
  it("is on, and well under a 100 s proxy idle limit", () => {
    expect(RPC_EVENT_STREAM_OPTIONS.eventIteratorKeepAliveEnabled).toBe(true);
    expect(RPC_EVENT_STREAM_OPTIONS.eventIteratorKeepAliveInterval).toBe(STREAM_KEEPALIVE_MS);
    expect(STREAM_KEEPALIVE_MS * 3).toBeLessThan(100_000);
  });

  it("sends keepalive comments on an event stream that has nothing to say", {
    timeout: 10_000,
  }, async () => {
    let release = () => {};
    const quiet = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = {
      watch: os.handler(async function* () {
        yield { type: "snapshot" };
        await quiet;
        yield { type: "event" };
      }),
    };
    // The production options with only the interval shortened.
    const handler = new RPCHandler(router, {
      ...RPC_EVENT_STREAM_OPTIONS,
      eventIteratorKeepAliveInterval: 20,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { matched, response } = await within(
        handler.handle(
          new Request("http://internal/rpc/watch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: null }),
          }),
          { prefix: "/rpc", context: {} },
        ),
      );
      expect(matched).toBe(true);
      if (!response?.body) throw new Error("no streamed response");
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const stream = response.body.getReader();
      reader = stream;
      const decoder = new TextDecoder();
      // Reads until `until` holds or the stream ends; the whole read is bounded.
      const read = async (until: (text: string) => boolean, text = "") => {
        const deadline = Date.now() + 3_000;
        while (!until(text)) {
          const { value, done } = await within(stream.read(), Math.max(0, deadline - Date.now()));
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        return text;
      };
      const keepalives = (text: string) => text.split(": keepalive\n").length - 1;
      const early = await read((text) => keepalives(text) >= 2);
      expect(early).toContain("snapshot");
      expect(keepalives(early)).toBeGreaterThanOrEqual(2);
      release();
      expect(await read(() => false)).toContain('"type":"event"');
    } finally {
      release();
      await reader?.cancel().catch(() => {});
    }
  });
});
