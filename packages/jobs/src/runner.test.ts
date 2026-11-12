import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const store = vi.hoisted(() => ({
  claimJobs: vi.fn(),
  markSucceeded: vi.fn(),
  markRetry: vi.fn(),
  markFailed: vi.fn(),
  recoverStaleJobs: vi.fn(),
  refreshLocks: vi.fn(),
  releaseClaim: vi.fn(),
}));
vi.mock("./store", () => store);

const { createJobRunner } = await import("./runner");
const { defineJob, handleJob, PermanentJobError } = await import("./define");
const { jobWakeups } = await import("./wakeups");

const echo = defineJob("test.echo", z.object({ message: z.string() }), {
  maxAttempts: 3,
  backoff: { baseMs: 1_000, maxMs: 10_000 },
});

function claimed(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "test.echo",
    payload: { message: id },
    attempts: 1,
    maxAttempts: 3,
    claimToken: "claim-1",
    ...overrides,
  };
}

/** Let queued microtasks and promise chains settle. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("createJobRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.recoverStaleJobs.mockResolvedValue({ requeued: 0, failed: 0, failedJobs: [] });
    store.claimJobs.mockResolvedValue([]);
    store.markSucceeded.mockResolvedValue(true);
    store.markRetry.mockResolvedValue(true);
    store.markFailed.mockResolvedValue(true);
    store.refreshLocks.mockResolvedValue([]);
    store.releaseClaim.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers stale running rows on boot before claiming", async () => {
    const order: string[] = [];
    store.recoverStaleJobs.mockImplementation(async () => {
      order.push("recover");
      return { requeued: 1, failed: 0, failedJobs: [] };
    });
    store.claimJobs.mockImplementation(async () => {
      order.push("claim");
      return [];
    });
    const runner = createJobRunner({
      jobs: [handleJob(echo, async () => {})],
      now: () => 500_000,
      staleLockMs: 60_000,
    });
    await runner.start();
    await flush();
    expect(order.slice(0, 2)).toEqual(["recover", "claim"]);
    // Only locks older than the stale window: an overlapping old process's
    // live (refreshed) locks are left alone.
    expect(store.recoverStaleJobs.mock.calls[0]?.[0]).toEqual(new Date(440_000));
    await runner.stop();
  });

  it("runs a claimed job with its parsed payload and marks it succeeded", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    store.claimJobs.mockResolvedValueOnce([claimed("j1")]);
    const runner = createJobRunner({ jobs: [handleJob(echo, handler)], workerId: "w1" });
    await runner.start();
    await flush();
    expect(store.claimJobs).toHaveBeenCalledWith("w1", ["test.echo"], 2, []);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "j1", payload: { message: "j1" }, attempt: 1, maxAttempts: 3 }),
    );
    expect(store.markSucceeded).toHaveBeenCalledWith("j1", "claim-1");
    await runner.stop();
  });

  it("never claims more than its free concurrency", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.claimJobs.mockImplementation(async (_w: string, _t: string[], limit: number) =>
      Array.from({ length: limit }, (_, i) => claimed(`j${i}-${limit}`)),
    );
    const runner = createJobRunner({
      jobs: [handleJob(echo, () => blocked)],
      concurrency: 3,
    });
    await runner.start();
    await flush();
    expect(store.claimJobs.mock.calls[0]?.[2]).toBe(3);
    expect(runner.activeJobIds()).toHaveLength(3);
    runner.wake();
    await flush();
    // Full: the wakeup must not claim anything.
    expect(store.claimJobs).toHaveBeenCalledTimes(1);
    store.claimJobs.mockResolvedValue([]);
    release();
    await flush();
    await runner.stop();
  });

  it("schedules a retry with exponential backoff while attempts remain", async () => {
    store.claimJobs.mockResolvedValueOnce([claimed("j1", { attempts: 2 })]);
    const runner = createJobRunner({
      jobs: [
        handleJob(echo, async () => {
          throw new Error("flaky");
        }),
      ],
      workerId: "w1",
      now: () => 100_000,
    });
    await runner.start();
    await flush();
    expect(store.markRetry).toHaveBeenCalledWith(
      "j1",
      "claim-1",
      "flaky",
      new Date(100_000 + 2_000),
    );
    expect(store.markFailed).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("fails on the last attempt and reports the terminal failure once", async () => {
    const onTerminalFailure = vi.fn();
    store.claimJobs.mockResolvedValueOnce([claimed("j1", { attempts: 3 })]);
    const runner = createJobRunner({
      jobs: [
        handleJob(echo, async () => {
          throw new Error("still broken");
        }),
      ],
      workerId: "w1",
      onTerminalFailure,
    });
    await runner.start();
    await flush();
    expect(store.markRetry).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith("j1", "claim-1", "still broken");
    expect(onTerminalFailure).toHaveBeenCalledWith({
      id: "j1",
      type: "test.echo",
      attempts: 3,
      error: "still broken",
    });
    await runner.stop();
  });

  it("fails immediately on an invalid payload or a PermanentJobError", async () => {
    const handler = vi.fn(async ({ payload }: { payload: { message: string } }) => {
      if (payload.message === "j2") throw new PermanentJobError("pointless");
    });
    store.claimJobs.mockResolvedValueOnce([
      claimed("j1", { payload: { message: 42 } }),
      claimed("j2"),
    ]);
    const runner = createJobRunner({ jobs: [handleJob(echo, handler)], workerId: "w1" });
    await runner.start();
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.markFailed).toHaveBeenCalledWith(
      "j1",
      "claim-1",
      expect.stringContaining("Invalid payload"),
    );
    expect(store.markFailed).toHaveBeenCalledWith("j2", "claim-1", "pointless");
    expect(store.markRetry).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("does not report a terminal failure when the lock was lost", async () => {
    const onTerminalFailure = vi.fn();
    store.markFailed.mockResolvedValue(false);
    store.claimJobs.mockResolvedValueOnce([claimed("j1", { attempts: 3 })]);
    const runner = createJobRunner({
      jobs: [
        handleJob(echo, async () => {
          throw new Error("x");
        }),
      ],
      onTerminalFailure,
    });
    await runner.start();
    await flush();
    expect(onTerminalFailure).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("claims as soon as a job is enqueued in-process", async () => {
    const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
    await runner.start();
    await flush();
    const before = store.claimJobs.mock.calls.length;
    jobWakeups.publish("enqueued", { type: "test.echo" });
    await flush();
    expect(store.claimJobs.mock.calls.length).toBe(before + 1);
    await runner.stop();
    jobWakeups.publish("enqueued", { type: "test.echo" });
    await flush();
    expect(store.claimJobs.mock.calls.length).toBe(before + 1);
  });

  it("reports failing health when the claim query errors, and recovers", async () => {
    store.claimJobs.mockRejectedValueOnce(new Error("db down"));
    const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
    expect(runner.health()).toBe("stopped");
    await runner.start();
    await flush();
    expect(runner.health()).toBe("failing");
    runner.wake();
    await flush();
    expect(runner.health()).toBe("running");
    await runner.stop();
    expect(runner.health()).toBe("stopped");
  });

  it("drains in-flight jobs on stop", async () => {
    let release: () => void = () => {};
    const handlerDone = vi.fn();
    store.claimJobs.mockResolvedValueOnce([claimed("j1")]);
    const runner = createJobRunner({
      jobs: [
        handleJob(echo, async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          handlerDone();
        }),
      ],
      drainTimeoutMs: 1_000,
    });
    await runner.start();
    await flush();
    const stopped = runner.stop();
    release();
    await expect(stopped).resolves.toBe(true);
    expect(handlerDone).toHaveBeenCalled();
    expect(store.markSucceeded).toHaveBeenCalled();
    await expect(runner.stop()).resolves.toBe(true);
  });

  it("aborts jobs that outlive the drain deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    store.claimJobs.mockResolvedValueOnce([claimed("j1")]);
    const runner = createJobRunner({
      jobs: [
        handleJob(echo, (context) => {
          signal = context.signal;
          return new Promise<void>(() => {});
        }),
      ],
      drainTimeoutMs: 500,
    });
    await runner.start();
    await flush();
    const stopped = runner.stop();
    await vi.advanceTimersByTimeAsync(600);
    await expect(stopped).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(store.markSucceeded).not.toHaveBeenCalled();
  });

  it("refreshes locks for in-flight jobs", async () => {
    vi.useFakeTimers();
    store.claimJobs.mockResolvedValueOnce([claimed("j1")]);
    const runner = createJobRunner({
      jobs: [handleJob(echo, () => new Promise<void>(() => {}))],
      staleLockMs: 30_000,
      workerId: "w1",
      drainTimeoutMs: 10,
    });
    await runner.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.refreshLocks).toHaveBeenCalledWith([{ id: "j1", claimToken: "claim-1" }]);
    const stopped = runner.stop();
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
  });

  it("rejects duplicate registrations and invalid concurrency", () => {
    const job = handleJob(echo, async () => {});
    expect(() => createJobRunner({ jobs: [job, job] })).toThrow(/registered twice/);
    expect(() => createJobRunner({ jobs: [job], concurrency: 0 })).toThrow(/concurrency/);
  });

  it("cannot be started twice", async () => {
    const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
    await runner.start();
    await expect(runner.start()).rejects.toThrow(/already started/);
    await runner.stop();
  });

  it("cannot be started twice even while the first start is still recovering", async () => {
    let finishRecovery: () => void = () => {};
    store.recoverStaleJobs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRecovery = () => resolve({ requeued: 0, failed: 0, failedJobs: [] });
        }),
    );
    const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
    const first = runner.start();
    await expect(runner.start()).rejects.toThrow(/already started/);
    finishRecovery();
    await first;
    expect(runner.health()).toBe("running");
    await runner.stop();
  });

  describe("a successful handler whose success write fails", () => {
    it("retries the write once and never records a failure", async () => {
      const onTerminalFailure = vi.fn();
      store.markSucceeded.mockRejectedValueOnce(new Error("connection reset"));
      store.claimJobs.mockResolvedValueOnce([claimed("j1", { attempts: 3, maxAttempts: 3 })]);
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        workerId: "w1",
        onTerminalFailure,
      });
      await runner.start();
      await flush();
      expect(store.markSucceeded).toHaveBeenCalledTimes(2);
      expect(store.markSucceeded).toHaveBeenNthCalledWith(2, "j1", "claim-1");
      expect(store.markRetry).not.toHaveBeenCalled();
      expect(store.markFailed).not.toHaveBeenCalled();
      expect(onTerminalFailure).not.toHaveBeenCalled();
      await runner.stop();
    });

    it("leaves the row running for stale recovery when the retry fails too", async () => {
      const onTerminalFailure = vi.fn();
      store.markSucceeded.mockRejectedValue(new Error("db down"));
      store.claimJobs.mockResolvedValueOnce([claimed("j1", { attempts: 1, maxAttempts: 1 })]);
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
      });
      await runner.start();
      await flush();
      expect(store.markSucceeded).toHaveBeenCalledTimes(2);
      expect(store.markRetry).not.toHaveBeenCalled();
      expect(store.markFailed).not.toHaveBeenCalled();
      expect(onTerminalFailure).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("could not be marked succeeded"),
        "db down",
      );
      expect(runner.activeJobIds()).toEqual([]);
      await runner.stop();
    });
  });

  describe("stale recovery of exhausted rows", () => {
    const exhausted = {
      id: "j9",
      type: "test.echo",
      attempts: 3,
      lastError: "Lock expired: the process running this job stopped before it finished.",
    };

    it("reports each row failed by boot recovery as a terminal failure", async () => {
      const onTerminalFailure = vi.fn();
      store.recoverStaleJobs.mockResolvedValueOnce({
        requeued: 0,
        failed: 2,
        failedJobs: [exhausted, { ...exhausted, id: "j10", attempts: 1 }],
      });
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
      });
      await runner.start();
      await flush();
      expect(onTerminalFailure).toHaveBeenCalledTimes(2);
      expect(onTerminalFailure).toHaveBeenNthCalledWith(1, {
        id: "j9",
        type: "test.echo",
        attempts: 3,
        error: exhausted.lastError,
      });
      expect(onTerminalFailure).toHaveBeenNthCalledWith(2, {
        id: "j10",
        type: "test.echo",
        attempts: 1,
        error: exhausted.lastError,
      });
      await runner.stop();
    });

    it("reports rows failed by the periodic sweep, and survives a throwing hook", async () => {
      let clock = 1_000_000;
      const onTerminalFailure = vi.fn().mockRejectedValue(new Error("smtp down"));
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
        staleLockMs: 60_000,
        now: () => clock,
      });
      await runner.start();
      await flush();
      expect(onTerminalFailure).not.toHaveBeenCalled();

      store.recoverStaleJobs.mockResolvedValueOnce({
        requeued: 1,
        failed: 1,
        failedJobs: [exhausted],
      });
      clock += 60_000;
      runner.wake();
      await flush();
      expect(store.recoverStaleJobs).toHaveBeenCalledTimes(2);
      expect(onTerminalFailure).toHaveBeenCalledWith({
        id: "j9",
        type: "test.echo",
        attempts: 3,
        error: exhausted.lastError,
      });
      expect(console.error).toHaveBeenCalledWith(
        "[jobs] onTerminalFailure hook threw:",
        "smtp down",
      );
      expect(runner.health()).toBe("running");
      await runner.stop();
    });

    it("stop() waits for a report still being delivered", async () => {
      let deliver: () => void = () => {};
      const onTerminalFailure = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            deliver = resolve;
          }),
      );
      store.recoverStaleJobs.mockResolvedValueOnce({
        requeued: 0,
        failed: 1,
        failedJobs: [exhausted],
      });
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
      });
      await runner.start();
      await flush();
      expect(onTerminalFailure).toHaveBeenCalledOnce();
      let stopResolved = false;
      const stopped = runner.stop().then((drained) => {
        stopResolved = true;
        return drained;
      });
      await flush();
      expect(stopResolved).toBe(false);
      deliver();
      await expect(stopped).resolves.toBe(true);
    });

    it("stop() waits for reports a stale sweep already in flight starts", async () => {
      let clock = 1_000_000;
      let finishSweep: () => void = () => {};
      let deliver: () => void = () => {};
      const onTerminalFailure = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            deliver = resolve;
          }),
      );
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
        staleLockMs: 60_000,
        now: () => clock,
      });
      await runner.start();
      await flush();
      store.recoverStaleJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSweep = () => resolve({ requeued: 0, failed: 1, failedJobs: [exhausted] });
          }),
      );
      clock += 60_000;
      runner.wake();
      await flush();
      let stopResolved = false;
      const stopped = runner.stop().then((drained) => {
        stopResolved = true;
        return drained;
      });
      await flush();
      expect(stopResolved).toBe(false);
      // The sweep lands after stop() began; its report is still awaited.
      finishSweep();
      await flush();
      expect(onTerminalFailure).toHaveBeenCalledOnce();
      expect(stopResolved).toBe(false);
      deliver();
      await expect(stopped).resolves.toBe(true);
    });

    it("never lets a hung report hold stop() past the drain deadline", async () => {
      vi.useFakeTimers();
      const onTerminalFailure = vi.fn(() => new Promise<void>(() => {}));
      store.recoverStaleJobs.mockResolvedValueOnce({
        requeued: 0,
        failed: 1,
        failedJobs: [exhausted],
      });
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
        drainTimeoutMs: 500,
      });
      await runner.start();
      await flush();
      let stopResolved = false;
      const stopped = runner.stop().then((drained) => {
        stopResolved = true;
        return drained;
      });
      await vi.advanceTimersByTimeAsync(400);
      expect(stopResolved).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(stopped).resolves.toBe(true);
      expect(runner.health()).toBe("stopped");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("terminal-failure report(s) still running after 500ms"),
      );
    });

    it("bounds a stop() during boot recovery by the drain deadline for its reports", async () => {
      vi.useFakeTimers();
      let finishRecovery: () => void = () => {};
      store.recoverStaleJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRecovery = () => resolve({ requeued: 0, failed: 1, failedJobs: [exhausted] });
          }),
      );
      const onTerminalFailure = vi.fn(() => new Promise<void>(() => {}));
      const runner = createJobRunner({
        jobs: [handleJob(echo, async () => {})],
        onTerminalFailure,
        drainTimeoutMs: 500,
      });
      const started = runner.start();
      await flush();
      const stopped = runner.stop();
      finishRecovery();
      await expect(started).resolves.toBeUndefined();
      expect(onTerminalFailure).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      await expect(stopped).resolves.toBe(true);
      expect(runner.health()).toBe("stopped");
    });
  });

  describe("stop() while start() is recovering", () => {
    it("keeps the runner stopped once recovery settles", async () => {
      let finishRecovery: () => void = () => {};
      store.recoverStaleJobs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRecovery = () => resolve({ requeued: 0, failed: 0, failedJobs: [] });
          }),
      );
      const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
      const started = runner.start();
      await flush();
      let stopResolved = false;
      const stopped = runner.stop().then((drained) => {
        stopResolved = true;
        return drained;
      });
      await flush();
      // stop() waits for the in-flight recovery before resolving.
      expect(stopResolved).toBe(false);
      finishRecovery();
      await expect(started).resolves.toBeUndefined();
      await expect(stopped).resolves.toBe(true);
      await flush();
      expect(runner.health()).toBe("stopped");
      expect(store.claimJobs).not.toHaveBeenCalled();
      jobWakeups.publish("enqueued", { type: "test.echo" });
      runner.wake();
      await flush();
      expect(store.claimJobs).not.toHaveBeenCalled();
      await expect(runner.start()).rejects.toThrow(/already started/);
    });

    it("resolves stop() when the interrupted recovery fails", async () => {
      let failRecovery: () => void = () => {};
      store.recoverStaleJobs.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failRecovery = () => reject(new Error("db down"));
          }),
      );
      const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
      const started = runner.start();
      await flush();
      const stopped = runner.stop();
      failRecovery();
      await expect(started).rejects.toThrow("db down");
      await expect(stopped).resolves.toBe(true);
      expect(runner.health()).toBe("stopped");
      await expect(runner.start()).rejects.toThrow(/already started/);
    });
  });

  it("can retry start() after its recovery fails", async () => {
    store.recoverStaleJobs.mockRejectedValueOnce(new Error("db down"));
    const runner = createJobRunner({ jobs: [handleJob(echo, async () => {})] });
    await expect(runner.start()).rejects.toThrow("db down");
    expect(runner.health()).toBe("stopped");
    await runner.start();
    expect(runner.health()).toBe("running");
    await runner.stop();
  });
});

describe("claim shutdown and attempt isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    store.recoverStaleJobs.mockResolvedValue({ requeued: 0, failed: 0, failedJobs: [] });
    store.claimJobs.mockResolvedValue([]);
    store.releaseClaim.mockResolvedValue(undefined);
    store.refreshLocks.mockResolvedValue([]);
    store.markSucceeded.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for a pending claim and its guarded release before reporting drained", async () => {
    let settleClaim!: (jobs: ReturnType<typeof claimed>[]) => void;
    store.claimJobs.mockReturnValueOnce(
      new Promise((resolve) => {
        settleClaim = resolve;
      }),
    );
    let release!: () => void;
    store.releaseClaim.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const handler = vi.fn();
    const runner = createJobRunner({ jobs: [handleJob(echo, handler)], drainTimeoutMs: 100 });
    await runner.start();
    await flush();
    let stopped: boolean | undefined;
    const stopping = runner.stop().then((result) => {
      stopped = result;
      return result;
    });
    await flush();
    expect(stopped).toBeUndefined();
    settleClaim([claimed("j1")]);
    await flush();
    expect(stopped).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(store.releaseClaim).toHaveBeenCalledWith(claimed("j1"));
    release();
    await expect(stopping).resolves.toBe(true);
  });

  it("reports an unresolved claim as an unsuccessful drain and never starts its late job", async () => {
    let settleClaim!: (jobs: ReturnType<typeof claimed>[]) => void;
    store.claimJobs.mockReturnValueOnce(
      new Promise((resolve) => {
        settleClaim = resolve;
      }),
    );
    const handler = vi.fn();
    const runner = createJobRunner({ jobs: [handleJob(echo, handler)], drainTimeoutMs: 100 });
    await runner.start();
    await flush();
    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toBe(false);
    settleClaim([claimed("j1")]);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(store.releaseClaim).toHaveBeenCalledOnce();
  });

  it("does not recover or reclaim a locally executing job when heartbeats fail", async () => {
    let row: "queued" | "running" | "succeeded" = "queued";
    let attempt = 0;
    store.claimJobs.mockImplementation(async (_worker, _types, _limit, excluded: string[] = []) => {
      if (row !== "queued" || excluded.includes("j1")) return [];
      row = "running";
      return [claimed("j1", { claimToken: `claim-${++attempt}` })];
    });
    store.recoverStaleJobs.mockImplementation(async (_before, excluded: string[] = []) => {
      const requeued = row === "running" && !excluded.includes("j1") ? 1 : 0;
      if (requeued) row = "queued";
      return { requeued, failed: 0, failedJobs: [] };
    });
    store.refreshLocks.mockRejectedValue(new Error("heartbeat unavailable"));
    store.markSucceeded.mockImplementation(async (_id, token) => {
      if (token !== `claim-${attempt}` || row !== "running") return false;
      row = "succeeded";
      return true;
    });
    let finish!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const runner = createJobRunner({
      jobs: [handleJob(echo, handler)],
      concurrency: 2,
      staleLockMs: 3_000,
      pollIntervalMs: 1_000,
    });
    await runner.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runner.activeJobIds()).toEqual(["j1"]);
    expect(store.recoverStaleJobs.mock.calls.at(-1)?.[1]).toEqual(["j1"]);
    finish();
    await flush();
    expect(row).toBe("succeeded");
    await runner.stop();
  });
});

it("does not report a clean stop if returning an unstarted claim fails", async () => {
  vi.resetAllMocks();
  store.recoverStaleJobs.mockResolvedValue({ requeued: 0, failed: 0, failedJobs: [] });
  let settleClaim!: (rows: ReturnType<typeof claimed>[]) => void;
  store.claimJobs.mockReturnValueOnce(
    new Promise((resolve) => {
      settleClaim = resolve;
    }),
  );
  store.releaseClaim.mockRejectedValue(new Error("database unavailable"));
  const runner = createJobRunner({ jobs: [handleJob(echo, vi.fn())] });
  await runner.start();
  await flush();
  const stopping = runner.stop();
  settleClaim([claimed("j1"), claimed("j2")]);
  await expect(stopping).resolves.toBe(false);
  expect(store.releaseClaim).toHaveBeenCalledTimes(2);
});
