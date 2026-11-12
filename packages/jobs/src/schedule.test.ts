import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const store = vi.hoisted(() => ({ enqueueJob: vi.fn() }));
vi.mock("./store", () => store);

const { defineJob } = await import("./define");
const { DAY, HOUR, MINUTE, slotStart, startPeriodicJob } = await import("./schedule");

const sweep = defineJob("test.sweep", z.object({ reason: z.literal("cron") }));

function fakeClock(start: number) {
  let now = start;
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  return {
    clock: {
      now: () => now,
      setTimeout(callback: () => void, ms: number) {
        const timer = { at: now + ms, callback, cleared: false };
        timers.push(timer);
        return Object.assign(timer, { unref: () => {} });
      },
      clearTimeout(handle: unknown) {
        if (handle && typeof handle === "object") (handle as { cleared: boolean }).cleared = true;
      },
    },
    timers,
    async advanceTo(at: number) {
      now = at;
      for (const timer of timers.splice(0)) {
        if (!timer.cleared && timer.at <= at) timer.callback();
        else if (!timer.cleared) timers.push(timer);
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("slotStart", () => {
  it("anchors slots at the offset", () => {
    const offset = 4 * HOUR + 17 * MINUTE;
    const day = Date.UTC(2026, 9, 24);
    expect(slotStart(day + 5 * HOUR, DAY, offset)).toBe(day + offset);
    // Before 04:17 the current slot is still yesterday's.
    expect(slotStart(day + 3 * HOUR, DAY, offset)).toBe(day - DAY + offset);
  });
});

describe("startPeriodicJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.enqueueJob.mockResolvedValue({ id: "j", created: true });
  });

  it("enqueues the current slot at boot (catch-up) with a slot dedupe key", async () => {
    const base = Date.UTC(2026, 9, 24, 10, 0, 0);
    const { clock } = fakeClock(base);
    const stop = startPeriodicJob(
      { definition: sweep, payload: { reason: "cron" }, everyMs: 6 * HOUR, offsetMs: 20 * MINUTE },
      clock,
    );
    await flush();
    const slot = Date.UTC(2026, 9, 24, 6, 20, 0);
    expect(store.enqueueJob).toHaveBeenCalledWith(
      sweep,
      { reason: "cron" },
      {
        runAt: new Date(slot),
        dedupeKey: `periodic:test.sweep:${new Date(slot).toISOString()}`,
      },
    );
    stop();
  });

  it("enqueues once per slot and stops cleanly", async () => {
    const base = Date.UTC(2026, 9, 24, 0, 30, 0);
    const fake = fakeClock(base);
    const stop = startPeriodicJob(
      { definition: sweep, payload: { reason: "cron" }, everyMs: HOUR },
      fake.clock,
    );
    await flush();
    expect(store.enqueueJob).toHaveBeenCalledTimes(1);
    await fake.advanceTo(Date.UTC(2026, 9, 24, 1, 0, 1));
    expect(store.enqueueJob).toHaveBeenCalledTimes(2);
    expect(store.enqueueJob.mock.calls[1]?.[2].runAt).toEqual(new Date(Date.UTC(2026, 9, 24, 1)));
    stop();
    await fake.advanceTo(Date.UTC(2026, 9, 24, 3, 0, 1));
    expect(store.enqueueJob).toHaveBeenCalledTimes(2);
  });

  it("keeps scheduling after an enqueue error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.enqueueJob.mockRejectedValueOnce(new Error("db down"));
    const base = Date.UTC(2026, 9, 24, 0, 30, 0);
    const fake = fakeClock(base);
    const stop = startPeriodicJob(
      { definition: sweep, payload: { reason: "cron" }, everyMs: HOUR },
      fake.clock,
    );
    await flush();
    await fake.advanceTo(Date.UTC(2026, 9, 24, 1, 0, 1));
    expect(store.enqueueJob).toHaveBeenCalledTimes(2);
    stop();
  });

  it("refuses sub-minute schedules", () => {
    expect(() =>
      startPeriodicJob({ definition: sweep, payload: { reason: "cron" }, everyMs: 1_000 }),
    ).toThrow(/everyMs/);
  });
});
