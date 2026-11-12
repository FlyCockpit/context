import { describe, expect, it, vi } from "vitest";
import { createEventBus, EventBusOverflowError } from "./event-bus";

type Event = { n: number };

describe("createEventBus", () => {
  it("delivers only to subscribers of the published topic", () => {
    const bus = createEventBus<Event>({ name: "test" });
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("a", a);
    bus.subscribe("b", b);
    expect(bus.publish("a", { n: 1 })).toBe(1);
    expect(a).toHaveBeenCalledWith({ n: 1 });
    expect(b).not.toHaveBeenCalled();
  });

  it("returns zero and does nothing for a topic nobody watches", () => {
    const bus = createEventBus<Event>({ name: "test" });
    expect(bus.publish("nobody", { n: 1 })).toBe(0);
  });

  it("unsubscribes idempotently", () => {
    const bus = createEventBus<Event>({ name: "test" });
    const listener = vi.fn();
    const off = bus.subscribe("t", listener);
    expect(bus.listenerCount("t")).toBe(1);
    off();
    off();
    expect(bus.listenerCount("t")).toBe(0);
    bus.publish("t", { n: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the publisher and the other subscribers", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createEventBus<Event>({ name: "test" });
    const after = vi.fn();
    bus.subscribe("t", () => {
      throw new Error("boom");
    });
    bus.subscribe("t", after);
    expect(() => bus.publish("t", { n: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledWith({ n: 1 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("does not warn about listener leaks for many subscribers on one topic", () => {
    const warn = vi.spyOn(process, "emitWarning");
    const bus = createEventBus<Event>({ name: "test" });
    for (let i = 0; i < 50; i++) bus.subscribe("t", () => {});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("iterate", () => {
    it("yields buffered and live events in order, then ends on abort", async () => {
      const bus = createEventBus<Event>({ name: "test" });
      const controller = new AbortController();
      const iterator = bus.iterate("t", { signal: controller.signal });
      bus.publish("t", { n: 1 });
      bus.publish("t", { n: 2 });
      await expect(iterator.next()).resolves.toEqual({ value: { n: 1 }, done: false });
      await expect(iterator.next()).resolves.toEqual({ value: { n: 2 }, done: false });
      const waiting = iterator.next();
      bus.publish("t", { n: 3 });
      await expect(waiting).resolves.toEqual({ value: { n: 3 }, done: false });
      const ended = iterator.next();
      controller.abort();
      await expect(ended).resolves.toEqual({ value: undefined, done: true });
      expect(bus.listenerCount("t")).toBe(0);
    });

    it("detaches when the consumer breaks out of for-await", async () => {
      const bus = createEventBus<Event>({ name: "test" });
      const seen: number[] = [];
      const consumer = (async () => {
        for await (const event of bus.iterate("t")) {
          seen.push(event.n);
          if (event.n === 2) break;
        }
      })();
      bus.publish("t", { n: 1 });
      await Promise.resolve();
      bus.publish("t", { n: 2 });
      await consumer;
      expect(seen).toEqual([1, 2]);
      expect(bus.listenerCount("t")).toBe(0);
    });

    it("ends immediately for an already-aborted signal", async () => {
      const bus = createEventBus<Event>({ name: "test" });
      const iterator = bus.iterate("t", { signal: AbortSignal.abort() });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
      expect(bus.listenerCount("t")).toBe(0);
    });

    it("throws an overflow error instead of buffering without bound", async () => {
      const bus = createEventBus<Event>({ name: "test" });
      const iterator = bus.iterate("t", { maxBuffered: 2 });
      bus.publish("t", { n: 1 });
      bus.publish("t", { n: 2 });
      bus.publish("t", { n: 3 });
      await expect(iterator.next()).rejects.toBeInstanceOf(EventBusOverflowError);
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
      expect(bus.listenerCount("t")).toBe(0);
    });
  });
});
