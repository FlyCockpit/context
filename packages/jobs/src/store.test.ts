import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-context/db");
const { defineJob } = await import("./define");
const { jobWakeups } = await import("./wakeups");
const store = await import("./store");

const db = prisma as unknown as {
  $queryRaw: MockInstance;
  backgroundJob: {
    create: MockInstance;
    createManyAndReturn: MockInstance;
    findUniqueOrThrow: MockInstance;
    findMany: MockInstance;
    deleteMany: MockInstance;
    updateMany: MockInstance;
    updateManyAndReturn: MockInstance;
    fields: { maxAttempts: unknown };
  };
};

const echo = defineJob("test.echo", z.object({ message: z.string() }), { maxAttempts: 4 });

describe("enqueueJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the payload before touching the database", async () => {
    await expect(
      store.enqueueJob(echo, { message: 1 } as unknown as { message: string }),
    ).rejects.toThrow();
    expect(db.backgroundJob.create).not.toHaveBeenCalled();
  });

  it("inserts a queued row with the definition's attempts and wakes the runner", async () => {
    db.backgroundJob.create.mockResolvedValue({ id: "job-1" });
    const wake = vi.fn();
    const off = jobWakeups.subscribe("enqueued", wake);
    await expect(store.enqueueJob(echo, { message: "hi" })).resolves.toEqual({
      id: "job-1",
      created: true,
    });
    off();
    const data = db.backgroundJob.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      type: "test.echo",
      payload: { message: "hi" },
      maxAttempts: 4,
      dedupeKey: null,
    });
    expect(data.runAt).toBeInstanceOf(Date);
    expect(wake).toHaveBeenCalledWith({ type: "test.echo" });
  });

  it("returns the existing row for a duplicate dedupe key without waking", async () => {
    db.backgroundJob.createManyAndReturn.mockResolvedValue([]);
    db.backgroundJob.findUniqueOrThrow.mockResolvedValue({ id: "existing" });
    const wake = vi.fn();
    const off = jobWakeups.subscribe("enqueued", wake);
    await expect(store.enqueueJob(echo, { message: "hi" }, { dedupeKey: "k" })).resolves.toEqual({
      id: "existing",
      created: false,
    });
    off();
    expect(db.backgroundJob.createManyAndReturn.mock.calls[0]?.[0]).toMatchObject({
      skipDuplicates: true,
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("uses the transaction client when given one", async () => {
    const tx = { backgroundJob: { create: vi.fn().mockResolvedValue({ id: "tx-job" }) } };
    await store.enqueueJob(echo, { message: "hi" }, { db: tx as never });
    expect(tx.backgroundJob.create).toHaveBeenCalledOnce();
    expect(db.backgroundJob.create).not.toHaveBeenCalled();
  });
});

describe("claimJobs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not query when there is nothing to claim", async () => {
    await expect(store.claimJobs("w", [], 3)).resolves.toEqual([]);
    await expect(store.claimJobs("w", ["a"], 0)).resolves.toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("claims with SKIP LOCKED using bound parameters and validates the rows", async () => {
    db.$queryRaw.mockResolvedValue([
      {
        id: "j1",
        type: "a",
        payload: { x: 1 },
        attempts: 1,
        maxAttempts: 3,
        claimToken: "claim-1",
      },
    ]);
    const claimed = await store.claimJobs("worker-1", ["a", "b"], 2);
    expect(claimed).toEqual([
      {
        id: "j1",
        type: "a",
        payload: { x: 1 },
        attempts: 1,
        maxAttempts: 3,
        claimToken: "claim-1",
      },
    ]);
    const [strings, ...values] = db.$queryRaw.mock.calls[0] ?? [];
    const sql = (strings as string[]).join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain(`"attempts" = "attempts" + 1`);
    expect(values).toEqual([expect.stringMatching(/^worker-1:/), [], ["a", "b"], 2]);
  });

  it("rejects a malformed RETURNING row instead of trusting it", async () => {
    db.$queryRaw.mockResolvedValue([{ id: 1 }]);
    await expect(store.claimJobs("w", ["a"], 1)).rejects.toThrow();
  });
});

describe("runner writes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only touch rows this worker still owns", async () => {
    db.backgroundJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(store.markSucceeded("j1", "w1")).resolves.toBe(false);
    await store.markRetry("j1", "w1", "x".repeat(5_000), new Date(0));
    await store.markFailed("j1", "w1", "boom");
    for (const call of db.backgroundJob.updateMany.mock.calls) {
      expect(call[0].where).toEqual({ id: "j1", status: "running", lockedBy: "w1" });
    }
    const retry = db.backgroundJob.updateMany.mock.calls[1]?.[0]?.data;
    expect(retry.status).toBe("queued");
    expect(retry.lastError.length).toBe(store.MAX_ERROR_LENGTH);
  });

  it("recovers stale rows: exhausted ones fail first, the rest are requeued", async () => {
    const failedRow = {
      id: "j9",
      type: "test.echo",
      attempts: 3,
      lastError: "Lock expired: the process running this job stopped before it finished.",
    };
    const order: string[] = [];
    db.backgroundJob.updateManyAndReturn.mockImplementationOnce(async () => {
      order.push("fail");
      return [failedRow];
    });
    db.backgroundJob.updateMany.mockImplementationOnce(async () => {
      order.push("requeue");
      return { count: 2 };
    });
    const before = new Date("2026-01-01T00:00:00Z");
    await expect(store.recoverStaleJobs(before)).resolves.toEqual({
      requeued: 2,
      failed: 1,
      failedJobs: [failedRow],
    });
    expect(order).toEqual(["fail", "requeue"]);
    const failCall = db.backgroundJob.updateManyAndReturn.mock.calls[0];
    expect(failCall?.[0].where).toMatchObject({
      id: { notIn: [] },
      status: "running",
      OR: [{ lockedAt: { lt: before } }, { lockedAt: null }],
      attempts: { gte: db.backgroundJob.fields.maxAttempts },
    });
    expect(failCall?.[0].data).toMatchObject({
      status: "failed",
      lockedAt: null,
      lockedBy: null,
      lastError: failedRow.lastError,
    });
    expect(failCall?.[0].select).toEqual({ id: true, type: true, attempts: true, lastError: true });
    const requeueCall = db.backgroundJob.updateMany.mock.calls[0];
    expect(requeueCall?.[0].where).toEqual({
      id: { notIn: [] },
      status: "running",
      OR: [{ lockedAt: { lt: before } }, { lockedAt: null }],
    });
    expect(requeueCall?.[0].data.status).toBe("queued");
  });
});

describe("pruneFinishedJobs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes finished rows in bounded id pages and never queued/running ones", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` }));
    db.backgroundJob.findMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ id: "s-tail" }])
      .mockResolvedValueOnce([]);
    db.backgroundJob.deleteMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });
    const result = await store.pruneFinishedJobs({
      succeededOlderThan: new Date(1),
      failedOlderThan: new Date(2),
    });
    expect(result).toEqual({ deleted: 1001 });
    const statuses = db.backgroundJob.findMany.mock.calls.map((call) => call[0].where.status);
    expect(statuses).toEqual(["succeeded", "succeeded", "failed"]);
    for (const call of db.backgroundJob.findMany.mock.calls) expect(call[0].take).toBe(1000);
    for (const call of db.backgroundJob.deleteMany.mock.calls) {
      expect(call[0].where.id.in.length).toBeGreaterThan(0);
      expect(call[0].where.status).toBe("succeeded");
    }
  });
});

describe("retryFailedJob", () => {
  const dbWithFind = prisma as unknown as { backgroundJob: { findUnique: MockInstance } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requeues a failed row with a fresh attempt budget and wakes the runner", async () => {
    dbWithFind.backgroundJob.findUnique.mockResolvedValue({
      id: "job-1",
      type: "test.echo",
      status: "failed",
    });
    db.backgroundJob.updateMany.mockResolvedValue({ count: 1 });
    const wake = vi.fn();
    const off = jobWakeups.subscribe("enqueued", wake);
    await expect(store.retryFailedJob("job-1")).resolves.toEqual({
      retried: true,
      type: "test.echo",
    });
    off();
    expect(db.backgroundJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "failed" },
      data: expect.objectContaining({ status: "queued", attempts: 0, finishedAt: null }),
    });
    expect(wake).toHaveBeenCalledWith({ type: "test.echo" });
  });

  it("leaves rows that are not failed alone", async () => {
    dbWithFind.backgroundJob.findUnique.mockResolvedValue({
      id: "job-1",
      type: "test.echo",
      status: "running",
    });
    await expect(store.retryFailedJob("job-1")).resolves.toEqual({ retried: false });
    dbWithFind.backgroundJob.findUnique.mockResolvedValue(null);
    await expect(store.retryFailedJob("missing")).resolves.toEqual({
      retried: false,
      missing: true,
    });
    expect(db.backgroundJob.updateMany).not.toHaveBeenCalled();
  });

  it("reports a lost race as not retried", async () => {
    dbWithFind.backgroundJob.findUnique.mockResolvedValue({
      id: "job-1",
      type: "test.echo",
      status: "failed",
    });
    db.backgroundJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(store.retryFailedJob("job-1")).resolves.toEqual({ retried: false });
  });
});

describe("attempt fencing", () => {
  it("an old claim cannot heartbeat, finish, retry, or release a newer claim", async () => {
    let row = { id: "j1", status: "running", lockedBy: "new-token" };
    const matches = (where: { id: string; status: string; lockedBy: string }) =>
      where.id === row.id && where.status === row.status && where.lockedBy === row.lockedBy;
    db.backgroundJob.updateMany.mockImplementation(async ({ where, data }) => {
      if (!matches(where)) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    });
    db.backgroundJob.updateManyAndReturn.mockImplementation(async ({ where }) =>
      where.OR.some(matches) ? [{ id: row.id }] : [],
    );
    await expect(store.markSucceeded("j1", "old-token")).resolves.toBe(false);
    await expect(store.markFailed("j1", "old-token", "old failure")).resolves.toBe(false);
    await expect(store.markRetry("j1", "old-token", "retry", new Date())).resolves.toBe(false);
    await store.releaseClaim({
      id: "j1",
      claimToken: "old-token",
      type: "a",
      payload: {},
      attempts: 1,
      maxAttempts: 3,
    });
    await expect(store.refreshLocks([{ id: "j1", claimToken: "old-token" }])).resolves.toEqual([
      "j1",
    ]);
    expect(row).toEqual({ id: "j1", status: "running", lockedBy: "new-token" });
    await expect(store.markSucceeded("j1", "new-token")).resolves.toBe(true);
    expect(row.status).toBe("succeeded");
  });
});
