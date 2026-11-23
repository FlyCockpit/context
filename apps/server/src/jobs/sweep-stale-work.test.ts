import { beforeEach, describe, expect, it, vi } from "vitest";

const sweepStaleSnapshotSyncs = vi.fn();
const engine = { sweepStaleRuns: vi.fn() };
// @cockpit-context/jobs' store imports the Prisma client (env-validated at load).
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/api/lib/snapshot-tasks", () => ({ sweepStaleSnapshotSyncs }));
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: () => engine }));

const { sweepStaleWorkHandler, sweepStaleWorkJob, SWEEP_STALE_WORK_SCHEDULE } = await import(
  "./sweep-stale-work.js"
);

const run = () =>
  sweepStaleWorkHandler.handler({
    id: "j1",
    type: "work.sweep-stale",
    payload: { reason: "schedule" },
    attempt: 1,
    maxAttempts: 1,
    signal: new AbortController().signal,
  });

describe("work.sweep-stale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a single-attempt job every 5 minutes", () => {
    expect(sweepStaleWorkJob).toMatchObject({ type: "work.sweep-stale", maxAttempts: 1 });
    expect(SWEEP_STALE_WORK_SCHEDULE.everyMs).toBe(5 * 60_000);
    expect(sweepStaleWorkJob.payload.safeParse({ reason: "admin" }).success).toBe(false);
  });

  it("closes stale runs and snapshot syncs with a 5-minute grace, logging only when it did", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine.sweepStaleRuns.mockResolvedValue(0);
    sweepStaleSnapshotSyncs.mockResolvedValue(0);
    await run();
    expect(engine.sweepStaleRuns).toHaveBeenCalledWith(5 * 60_000);
    expect(sweepStaleSnapshotSyncs).toHaveBeenCalledWith(5 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    engine.sweepStaleRuns.mockResolvedValue(2);
    await run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("closed 2 stale run(s)"));
    warn.mockRestore();
  });
});
