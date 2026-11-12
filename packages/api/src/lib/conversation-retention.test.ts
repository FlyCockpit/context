import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-context/db");
const {
  CONVERSATION_RETENTION_BATCH,
  CONVERSATION_RETENTION_MAX_BATCHES,
  retentionCutoff,
  retentionWhere,
  sweepExpiredConversations,
} = await import("./conversation-retention");

const db = prisma as unknown as {
  conversation: { findMany: MockInstance; deleteMany: MockInstance };
  agentRun: { findMany: MockInstance; deleteMany: MockInstance };
  runTurn: { deleteMany: MockInstance };
  package: { deleteMany: MockInstance };
  packageProposal: { deleteMany: MockInstance };
  checkout: { deleteMany: MockInstance };
};

const NOW = new Date("2026-10-25T12:00:00Z");
const CUTOFF_90 = new Date("2026-07-27T12:00:00Z");

function ids(count: number, prefix = "c") {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
}

/** Evaluate the Prisma predicate against an in-memory conversation (boundary checks). */
type Row = {
  lastActivityAt: Date;
  updatedAt: Date;
  runs: Array<{
    status: string;
    createdAt: Date;
    updatedAt: Date;
    finishedAt: Date | null;
    turns: Date[];
  }>;
};

function eligible(row: Row, cutoff: Date): boolean {
  const before = (date: Date) => date.getTime() < cutoff.getTime();
  const runIsRecentOrLive = (run: Row["runs"][number]) =>
    run.status === "QUEUED" ||
    run.status === "RUNNING" ||
    !before(run.createdAt) ||
    !before(run.updatedAt) ||
    (run.finishedAt !== null && !before(run.finishedAt)) ||
    run.turns.some((turn) => !before(turn));
  return before(row.lastActivityAt) && before(row.updatedAt) && !row.runs.some(runIsRecentOrLive);
}

function oldRow(overrides: Partial<Row> = {}): Row {
  const old = new Date("2026-01-01T00:00:00Z");
  return {
    lastActivityAt: old,
    updatedAt: old,
    runs: [{ status: "COMPLETED", createdAt: old, updatedAt: old, finishedAt: old, turns: [old] }],
    ...overrides,
  };
}

describe("retentionCutoff", () => {
  it("is exactly N days before now", () => {
    expect(retentionCutoff(90, NOW)).toEqual(CUTOFF_90);
    expect(retentionCutoff(1, NOW)).toEqual(new Date("2026-10-24T12:00:00Z"));
  });
});

describe("retentionWhere", () => {
  it("requires every activity timestamp before the cutoff and no live run", () => {
    expect(retentionWhere(CUTOFF_90)).toEqual({
      lastActivityAt: { lt: CUTOFF_90 },
      updatedAt: { lt: CUTOFF_90 },
      AgentRuns: {
        none: {
          OR: [
            { status: { in: ["QUEUED", "RUNNING"] } },
            { createdAt: { gte: CUTOFF_90 } },
            { updatedAt: { gte: CUTOFF_90 } },
            { finishedAt: { gte: CUTOFF_90 } },
            { Turns: { some: { createdAt: { gte: CUTOFF_90 } } } },
          ],
        },
      },
    });
  });

  it("has no owner predicate: retention is global", () => {
    expect(JSON.stringify(retentionWhere(CUTOFF_90))).not.toMatch(/owner/i);
  });

  describe("cutoff boundaries (strictly older than the cutoff)", () => {
    const justBefore = new Date(CUTOFF_90.getTime() - 1);
    const at = CUTOFF_90;

    it("deletes a conversation whose latest activity is 1 ms before the cutoff", () => {
      expect(eligible(oldRow({ lastActivityAt: justBefore, updatedAt: justBefore }), at)).toBe(
        true,
      );
    });

    it("keeps one whose last activity is exactly at the cutoff", () => {
      expect(eligible(oldRow({ lastActivityAt: at }), at)).toBe(false);
      expect(eligible(oldRow({ updatedAt: at }), at)).toBe(false);
    });

    it.each([
      ["a run created", { createdAt: CUTOFF_90 }],
      ["a run updated", { updatedAt: CUTOFF_90 }],
      ["a run ended", { finishedAt: CUTOFF_90 }],
      ["a turn saved", { turns: [CUTOFF_90] }],
    ])("keeps one with %s at the cutoff", (_, run) => {
      const base = oldRow().runs[0];
      if (!base) throw new Error("fixture");
      expect(eligible(oldRow({ runs: [{ ...base, ...run }] }), at)).toBe(false);
    });

    it.each(["QUEUED", "RUNNING"])("keeps an old conversation with a %s run", (status) => {
      const base = oldRow().runs[0];
      if (!base) throw new Error("fixture");
      expect(eligible(oldRow({ runs: [{ ...base, status }] }), at)).toBe(false);
    });

    it.each(["COMPLETED", "FAILED", "STOPPED", "INTERRUPTED"])(
      "deletes an old conversation whose run is %s",
      (status) => {
        const base = oldRow().runs[0];
        if (!base) throw new Error("fixture");
        expect(eligible(oldRow({ runs: [{ ...base, status }] }), at)).toBe(true);
      },
    );
  });
});

describe("sweepExpiredConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.conversation.findMany.mockResolvedValue([]);
    db.conversation.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("does nothing at all when retention is 0 (keep until deleted)", async () => {
    await expect(sweepExpiredConversations(0, NOW)).resolves.toEqual({
      enabled: false,
      deleted: 0,
      batches: 0,
      capped: false,
    });
    expect(db.conversation.findMany).not.toHaveBeenCalled();
    expect(db.conversation.deleteMany).not.toHaveBeenCalled();
  });

  it("reads a bounded id page and deletes exactly those ids, re-predicated", async () => {
    db.conversation.findMany.mockResolvedValueOnce(ids(2));
    db.conversation.deleteMany.mockResolvedValueOnce({ count: 2 });
    const result = await sweepExpiredConversations(90, NOW);
    expect(result).toEqual({ enabled: true, deleted: 2, batches: 1, capped: false });
    const where = retentionWhere(CUTOFF_90);
    expect(db.conversation.findMany).toHaveBeenCalledWith({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: CONVERSATION_RETENTION_BATCH,
    });
    expect(db.conversation.deleteMany).toHaveBeenCalledWith({
      where: { AND: [where, { id: { in: ["c0", "c1"] } }] },
    });
  });

  it("loops over full batches until a short page", async () => {
    db.conversation.findMany
      .mockResolvedValueOnce(ids(CONVERSATION_RETENTION_BATCH, "a"))
      .mockResolvedValueOnce(ids(CONVERSATION_RETENTION_BATCH, "b"))
      .mockResolvedValueOnce(ids(3, "c"));
    db.conversation.deleteMany
      .mockResolvedValueOnce({ count: CONVERSATION_RETENTION_BATCH })
      .mockResolvedValueOnce({ count: CONVERSATION_RETENTION_BATCH })
      .mockResolvedValueOnce({ count: 3 });
    const result = await sweepExpiredConversations(90, NOW);
    expect(result).toEqual({
      enabled: true,
      deleted: 2 * CONVERSATION_RETENTION_BATCH + 3,
      batches: 3,
      capped: false,
    });
    expect(db.conversation.findMany).toHaveBeenCalledTimes(3);
  });

  it("stops when a full page deleted nothing (everything came back to life)", async () => {
    db.conversation.findMany.mockResolvedValue(ids(CONVERSATION_RETENTION_BATCH));
    db.conversation.deleteMany.mockResolvedValue({ count: 0 });
    const result = await sweepExpiredConversations(90, NOW);
    expect(result).toMatchObject({ deleted: 0, batches: 1, capped: false });
    expect(db.conversation.findMany).toHaveBeenCalledOnce();
  });

  it("stops at the batch cap and reports it", async () => {
    db.conversation.findMany.mockResolvedValue(ids(CONVERSATION_RETENTION_BATCH));
    db.conversation.deleteMany.mockResolvedValue({ count: CONVERSATION_RETENTION_BATCH });
    const result = await sweepExpiredConversations(90, NOW);
    expect(result).toEqual({
      enabled: true,
      deleted: CONVERSATION_RETENTION_MAX_BATCHES * CONVERSATION_RETENTION_BATCH,
      batches: CONVERSATION_RETENTION_MAX_BATCHES,
      capped: true,
    });
    expect(db.conversation.findMany).toHaveBeenCalledTimes(CONVERSATION_RETENTION_MAX_BATCHES);
  });

  it("deletes only conversations: runs and turns go by cascade, packages, proposals and checkouts are never touched", async () => {
    db.conversation.findMany.mockResolvedValueOnce(ids(1));
    db.conversation.deleteMany.mockResolvedValueOnce({ count: 1 });
    await sweepExpiredConversations(30, NOW);
    expect(db.agentRun.deleteMany).not.toHaveBeenCalled();
    expect(db.runTurn.deleteMany).not.toHaveBeenCalled();
    expect(db.package.deleteMany).not.toHaveBeenCalled();
    expect(db.packageProposal.deleteMany).not.toHaveBeenCalled();
    expect(db.checkout.deleteMany).not.toHaveBeenCalled();
  });
});
