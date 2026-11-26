import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ reportIfSessionRejected: vi.fn() }));
vi.mock("@/lib/document-identity", () => identity);

import { consumeWithReconnect, reconnectDelay, type StreamStatus } from "./stream-reconnect";

async function* events<T>(items: T[], fail?: Error): AsyncGenerator<T> {
  for (const item of items) yield item;
  if (fail) throw fail;
}

describe("reconnectDelay", () => {
  it("doubles from a second and caps at thirty", () => {
    expect([0, 1, 2, 3, 10].map(reconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 30_000]);
  });
});

describe("consumeWithReconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resubscribes after a drop and delivers every connection's events", async () => {
    const controller = new AbortController();
    const received: number[] = [];
    const statuses: StreamStatus[] = [];
    const connect = vi
      .fn<(signal: AbortSignal) => Promise<AsyncIterable<number>>>()
      .mockResolvedValueOnce(events([1, 2], new Error("network")))
      .mockResolvedValueOnce(events([3]))
      .mockImplementation(async () => {
        controller.abort();
        return events<number>([]);
      });

    const done = consumeWithReconnect({
      signal: controller.signal,
      connect,
      onEvent: (event) => received.push(event),
      onStatus: (status) => statuses.push(status),
    });
    await vi.runAllTimersAsync();
    await done;

    expect(received).toEqual([1, 2, 3]);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(statuses.slice(0, 5)).toEqual([
      "connecting",
      "live",
      "reconnecting",
      "live",
      "reconnecting",
    ]);
  });

  it("gives up on a fatal error", async () => {
    const statuses: StreamStatus[] = [];
    const notFound = Object.assign(new Error("gone"), { code: "NOT_FOUND" });
    const connect = vi.fn(async () => {
      throw notFound;
    });
    await consumeWithReconnect({
      signal: new AbortController().signal,
      connect,
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
      isFatal: (error) => error === notFound,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "failed"]);
  });

  it("reports a session rejection after a snapshot to the shared session check", async () => {
    const unauthorized = Object.assign(new Error("ended"), { code: "UNAUTHORIZED" });
    const events: string[] = [];
    identity.reportIfSessionRejected.mockReset();
    await consumeWithReconnect<string>({
      signal: new AbortController().signal,
      connect: async () =>
        (async function* () {
          yield "snapshot";
          throw unauthorized;
        })(),
      onEvent: (event) => events.push(event),
      onStatus: () => {},
      isFatal: (error) => error === unauthorized,
    });
    expect(events).toEqual(["snapshot"]);
    // The session ended elsewhere: one session check (lib/document-identity.ts)
    // replaces the document instead of leaving the retained view on screen.
    expect(identity.reportIfSessionRejected).toHaveBeenCalledExactlyOnceWith(unauthorized);
  });

  it("stops quietly once aborted", async () => {
    const controller = new AbortController();
    const connect = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    const statuses: StreamStatus[] = [];
    await consumeWithReconnect({
      signal: controller.signal,
      connect,
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses).toEqual(["connecting"]);
  });
});
