import { describe, expect, it, vi } from "vitest";

import { withLock } from "./locks";

describe("withLock", () => {
  it("serializes work on one key and releases after a failure", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withLock("k", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
      throw new Error("boom");
    });
    const second = withLock("k", async () => {
      order.push("second");
      return 2;
    });
    const other = withLock("other", async () => {
      order.push("other");
    });
    await other;
    release();
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });
});

it("aborts a queued waiter without releasing the current holder or blocking later callers", async () => {
  let release!: () => void;
  const first = withLock(
    "abort-queue",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const controller = new AbortController();
  let entered = false;
  const second = withLock(
    "abort-queue",
    async () => {
      entered = true;
    },
    controller.signal,
  );
  controller.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  const third = withLock("abort-queue", async () => {
    entered = true;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  release();
  await first;
  await third;
  expect(entered).toBe(true);
});

describe("withLock waitMs (request-bounded waits)", () => {
  it("answers REPOSITORY_BUSY after waitMs, leaves the queue, and never bounds the holder", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const holder = withLock(
        "busy",
        () =>
          new Promise<string>((resolve) => {
            release = () => resolve("held");
          }),
      );
      await Promise.resolve();
      let entered = false;
      const bounded = withLock(
        "busy",
        async () => {
          entered = true;
        },
        undefined,
        { waitMs: 10_000 },
      );
      const refused = expect(bounded).rejects.toMatchObject({
        name: "RepoError",
        code: "REPOSITORY_BUSY",
      });
      const later = withLock("busy", async () => "later");
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(entered).toBe(false);
      // Long past the bound, the holder still runs to its end.
      await vi.advanceTimersByTimeAsync(60_000);
      release();
      await expect(holder).resolves.toBe("held");
      await expect(later).resolves.toBe("later");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs at once when the lock is free, and the bound does not apply to the work itself", async () => {
    vi.useFakeTimers();
    try {
      const work = withLock(
        "free",
        () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 30_000)),
        undefined,
        { waitMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(work).resolves.toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
