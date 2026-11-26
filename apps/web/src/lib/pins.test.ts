import { describe, expect, it } from "vitest";

import { createOrderSaver, dropIndex, moveItem, sameMembers, sameOrder } from "./pins";

describe("moveItem", () => {
  it("moves an item up and down, clamping at the ends", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 3)).toEqual(["a", "b", "c"]);
  });

  it("leaves the input alone and ignores an unknown index", () => {
    const ids = ["a", "b"];
    expect(moveItem(ids, 5, 0)).toEqual(["a", "b"]);
    moveItem(ids, 0, 1);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("dropIndex", () => {
  const rows = [
    { id: "a", top: 0, height: 60 },
    { id: "b", top: 60, height: 100 },
    { id: "c", top: 160, height: 60 },
  ];

  it("counts the other rows whose middle is above the pointer", () => {
    expect(dropIndex(rows, "a", 30)).toBe(0);
    expect(dropIndex(rows, "a", 111)).toBe(1);
    expect(dropIndex(rows, "a", 191)).toBe(2);
    expect(dropIndex(rows, "c", 5)).toBe(0);
  });

  it("does not swap rows of different heights back under a still pointer", () => {
    // a (60 px) dragged past b's middle: b moves up to 0..100, a to 100..160.
    expect(dropIndex(rows, "a", 111)).toBe(1);
    const swapped = [
      { id: "b", top: 0, height: 100 },
      { id: "a", top: 100, height: 60 },
      { id: "c", top: 160, height: 60 },
    ];
    expect(dropIndex(swapped, "a", 111)).toBe(1);
  });
});

describe("sameOrder", () => {
  it("compares members and order", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});

describe("sameMembers", () => {
  it("ignores order but not membership", () => {
    expect(sameMembers(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameMembers(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameMembers(["a"], ["a", "b"])).toBe(false);
  });
});

describe("createOrderSaver", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  function harness() {
    const sent: string[][] = [];
    const pending: ReturnType<typeof deferred>[] = [];
    const saved: string[][] = [];
    const drained: string[] = [];
    const saver = createOrderSaver({
      send: (ids) => {
        sent.push(ids);
        const gate = deferred();
        pending.push(gate);
        return gate.promise;
      },
      onSaved: (ids) => {
        saved.push(ids);
      },
      onDrained: (result) => drained.push(result),
    });
    return { saver, sent, pending, saved, drained };
  }

  it("never overlaps saves and sends only the newest waiting order", async () => {
    const { saver, sent, pending, saved, drained } = harness();
    saver.save(["b", "a", "c"]);
    saver.save(["b", "c", "a"]);
    saver.save(["c", "b", "a"]);
    // One save in flight; the second order was superseded before it was sent.
    expect(sent).toEqual([["b", "a", "c"]]);
    expect(saver.desired()).toEqual(["c", "b", "a"]);
    pending[0]?.resolve();
    await flush();
    expect(sent).toEqual([
      ["b", "a", "c"],
      ["c", "b", "a"],
    ]);
    pending[1]?.resolve();
    await flush();
    expect(saved).toEqual(sent);
    expect(drained).toEqual(["saved"]);
    expect(saver.desired()).toBeNull();
  });

  it("keeps the newest order on show until the queue drains, and tells subscribers", async () => {
    const { saver, pending } = harness();
    const seen: (string[] | null)[] = [];
    const stop = saver.subscribe(() => seen.push(saver.desired()));
    saver.save(["b", "a"]);
    expect(saver.desired()).toEqual(["b", "a"]);
    pending[0]?.resolve();
    await flush();
    expect(seen).toEqual([["b", "a"], null]);
    stop();
    saver.save(["a", "b"]);
    expect(seen).toHaveLength(2);
  });

  it("after a partial success, leaves the last acknowledged order and drops what waited", async () => {
    const { saver, sent, pending, saved, drained } = harness();
    saver.save(["b", "a", "c"]);
    saver.save(["b", "c", "a"]);
    pending[0]?.resolve();
    await flush();
    pending[1]?.reject(new Error("offline"));
    await flush();
    // The first order was saved, the second failed: the cache keeps the first.
    expect(saved).toEqual([["b", "a", "c"]]);
    expect(drained).toEqual(["failed"]);
    expect(saver.desired()).toBeNull();
    // A later save starts a fresh queue.
    saver.save(["a", "b", "c"]);
    expect(sent).toHaveLength(3);
  });
});
