import { describe, expect, it } from "vitest";

import { RunScheduler } from "./scheduler";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("RunScheduler", () => {
  it("grants up to the global cap and queues the rest in arrival order", async () => {
    const scheduler = new RunScheduler({ global: 2, perUser: 5 });
    const granted: string[] = [];
    const releases: Array<() => void> = [];
    for (const name of ["a", "b", "c", "d"]) {
      void scheduler.acquire(name).then((release) => {
        granted.push(name);
        releases.push(release);
      });
    }
    await flush();
    expect(granted).toEqual(["a", "b"]);
    expect(scheduler.stats()).toEqual({ active: 2, queued: 2 });
    releases[0]?.();
    await flush();
    expect(granted).toEqual(["a", "b", "c"]);
  });

  it("passes over a user at their cap without blocking other users", async () => {
    const scheduler = new RunScheduler({ global: 3, perUser: 1 });
    const granted: string[] = [];
    const take = (label: string, owner: string) =>
      scheduler.acquire(owner).then((release) => {
        granted.push(label);
        return release;
      });
    const first = take("u1-a", "u1");
    void take("u1-b", "u1");
    void take("u2-a", "u2");
    await flush();
    expect(granted).toEqual(["u1-a", "u2-a"]);
    (await first)();
    await flush();
    expect(granted).toEqual(["u1-a", "u2-a", "u1-b"]);
  });

  it("lets a perUser: false waiter past its user's cap, bounded by the global cap", async () => {
    const scheduler = new RunScheduler({ global: 2, perUser: 1 });
    const granted: string[] = [];
    const take = (label: string, owner: string, perUser = true) =>
      scheduler.acquire(owner, undefined, { perUser }).then((release) => {
        granted.push(label);
        return release;
      });
    const first = take("u1-run", "u1");
    const summary = take("u1-summary", "u1", false);
    void take("u2-summary", "u2", false);
    await flush();
    expect(granted).toEqual(["u1-run", "u1-summary"]);
    expect(scheduler.stats()).toEqual({ active: 2, queued: 1 });
    (await summary)();
    await flush();
    expect(granted).toEqual(["u1-run", "u1-summary", "u2-summary"]);
    (await first)();
    expect(scheduler.stats()).toEqual({ active: 1, queued: 0 });
  });

  it("never counts a perUser: false slot toward its user's cap", async () => {
    const scheduler = new RunScheduler({ global: 3, perUser: 1 });
    const granted: string[] = [];
    void scheduler.acquire("u1", undefined, { perUser: false }).then(() => granted.push("summary"));
    void scheduler.acquire("u1").then(() => granted.push("run"));
    void scheduler.acquire("u1").then(() => granted.push("second run"));
    await flush();
    expect(granted).toEqual(["summary", "run"]);
    expect(scheduler.stats()).toEqual({ active: 2, queued: 1 });
  });

  it("drops an aborted waiter from the queue and rejects it", async () => {
    const scheduler = new RunScheduler({ global: 1, perUser: 1 });
    const release = await scheduler.acquire("u1");
    const controller = new AbortController();
    const waiting = scheduler.acquire("u2", controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(scheduler.stats()).toEqual({ active: 1, queued: 0 });
    release();
    expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("ignores a double release", async () => {
    const scheduler = new RunScheduler({ global: 1, perUser: 1 });
    const release = await scheduler.acquire("u1");
    release();
    release();
    expect(scheduler.stats().active).toBe(0);
    await expect(scheduler.acquire("u1", AbortSignal.abort("x"))).rejects.toBe("x");
  });
});
