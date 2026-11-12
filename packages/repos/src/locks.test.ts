import { describe, expect, it } from "vitest";

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
