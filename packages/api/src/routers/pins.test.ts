import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@cockpit-context/env/server", async () => {
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  return {
    env: {
      COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90,
      ...cockpitContextRateBudgetEnvDefaults(),
    },
    ADMIN_EMAILS: new Set<string>(),
  };
});
vi.mock("@cockpit-context/runs", () => ({
  getRunEngine: () => ({}),
  partsFromJson: () => [],
  runFailureFromJson: () => null,
}));

const { default: prisma } = await import("@cockpit-context/db");
const { pinsRouter } = await import("./pins");

const db = prisma as unknown as {
  $transaction: MockInstance;
  conversation: { findFirst: MockInstance };
  conversationPin: {
    findMany: MockInstance;
    findFirst: MockInstance;
    aggregate: MockInstance;
    create: MockInstance;
    deleteMany: MockInstance;
    updateMany: MockInstance;
  };
  agentRun: { groupBy: MockInstance };
};

const NOW = new Date("2026-11-26T00:00:00Z");

function conversationRow(id: string) {
  return {
    id,
    createdAt: NOW,
    title: `Question ${id}`,
    packageId: "pkg-1",
    packageIdentifier: "npm:react",
    requestedVersion: "19.0.0",
    requestedRef: null,
    commitSha: "c".repeat(40),
    resolvedFrom: "tag:v19.0.0",
    checkoutId: "co-1",
    origin: "WEB",
    mcpConnectionLabel: null,
    lastActivityAt: NOW,
    AgentRuns: [],
    _count: { AgentRuns: 0 },
  };
}

function client(userId = "user-a") {
  return createRouterClient(pinsRouter, { context: sessionContext({ id: userId }) });
}

function expectReason(code: string, reason?: string) {
  return (error: ORPCError<string, { reason?: string }>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
    return true;
  };
}

const visible = (userId: string) => ({ userId, Conversation: { ownerId: userId } });
const lost = (userId: string) => ({ userId, Conversation: { ownerId: { not: userId } } });

describe("pinsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (write: (tx: unknown) => unknown) => write(db));
    db.agentRun.groupBy.mockResolvedValue([]);
    db.conversationPin.deleteMany.mockResolvedValue({ count: 0 });
    db.conversationPin.findFirst.mockResolvedValue(null);
    db.conversationPin.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { position: null },
    });
    db.conversationPin.create.mockResolvedValue({ id: "pin-new" });
    db.conversationPin.updateMany.mockResolvedValue({ count: 1 });
  });

  it("requires a session for every procedure", async () => {
    const anonymous = createRouterClient(pinsRouter, { context: anonymousContext });
    await expect(anonymous.list()).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
    await expect(anonymous.pin({ id: "c1" })).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
    await expect(anonymous.unpin({ id: "c1" })).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
    await expect(anonymous.reorder({ ids: [] })).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
    expect(db.conversationPin.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  describe("list", () => {
    it("returns the caller's pins in order, only those whose conversation they still own", async () => {
      db.conversationPin.findMany.mockResolvedValue([
        { Conversation: conversationRow("c2") },
        { Conversation: conversationRow("c1") },
      ]);
      db.agentRun.groupBy.mockResolvedValue([
        { conversationId: "c1", _sum: { costUsdMicros: 700, unpricedCalls: 0 } },
      ]);
      const result = await client().list();
      const args = db.conversationPin.findMany.mock.calls[0]?.[0];
      // Access, not just the pin row, decides what shows.
      expect(args.where).toEqual(visible("user-a"));
      expect(args.orderBy).toEqual([{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
      expect(args.take).toBe(12);
      expect(result.limit).toBe(12);
      expect(result.items.map((item) => item.id)).toEqual(["c2", "c1"]);
      expect(result.items[1]?.totalCostUsdMicros).toBe(700);
      expect(db.agentRun.groupBy.mock.calls[0]?.[0].where).toEqual({
        ownerId: "user-a",
        conversationId: { in: ["c2", "c1"] },
      });
    });

    it("shows nothing of another user's pins", async () => {
      db.conversationPin.findMany.mockResolvedValue([]);
      const result = await client("user-b").list();
      expect(db.conversationPin.findMany.mock.calls[0]?.[0].where).toEqual(visible("user-b"));
      expect(result.items).toEqual([]);
    });
  });

  describe("pin", () => {
    it("pins an own conversation last, in a Serializable transaction", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c1" });
      db.conversationPin.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _max: { position: 7 },
      });
      await expect(client().pin({ id: "c1" })).resolves.toEqual({ pinned: true });
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "c1" }, { ownerId: "user-a" }],
      });
      expect(db.conversationPin.aggregate.mock.calls[0]?.[0].where).toEqual(visible("user-a"));
      expect(db.conversationPin.create.mock.calls[0]?.[0].data).toEqual({
        userId: "user-a",
        conversationId: "c1",
        position: 8,
      });
    });

    it("is NOT_FOUND for another user's (or a missing) conversation and pins nothing", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      await expect(client("user-b").pin({ id: "c1" })).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "c1" }, { ownerId: "user-b" }],
      });
      expect(db.conversationPin.create).not.toHaveBeenCalled();
    });

    it("drops pins whose conversation the caller no longer owns before counting", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c1" });
      await client().pin({ id: "c1" });
      expect(db.conversationPin.deleteMany).toHaveBeenCalledWith({ where: lost("user-a") });
      const deleted = db.conversationPin.deleteMany.mock.invocationCallOrder[0] ?? 0;
      const counted = db.conversationPin.aggregate.mock.invocationCallOrder[0] ?? 0;
      expect(deleted).toBeLessThan(counted);
    });

    it("is a no-op for a conversation already pinned, even at the limit", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c1" });
      db.conversationPin.findFirst.mockResolvedValue({ id: "pin-1" });
      db.conversationPin.aggregate.mockResolvedValue({
        _count: { _all: 12 },
        _max: { position: 11 },
      });
      await expect(client().pin({ id: "c1" })).resolves.toEqual({ pinned: true });
      expect(db.conversationPin.findFirst.mock.calls[0]?.[0].where).toEqual({
        userId: "user-a",
        conversationId: "c1",
      });
      expect(db.conversationPin.create).not.toHaveBeenCalled();
    });

    it("refuses a 13th pin with CONFLICT / PIN_LIMIT", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c13" });
      db.conversationPin.aggregate.mockResolvedValue({
        _count: { _all: 12 },
        _max: { position: 11 },
      });
      await expect(client().pin({ id: "c13" })).rejects.toSatisfy(
        expectReason("CONFLICT", "PIN_LIMIT"),
      );
      expect(db.conversationPin.create).not.toHaveBeenCalled();
    });

    it("allows the 12th pin", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c12" });
      db.conversationPin.aggregate.mockResolvedValue({
        _count: { _all: 11 },
        _max: { position: 10 },
      });
      await expect(client().pin({ id: "c12" })).resolves.toEqual({ pinned: true });
      expect(db.conversationPin.create).toHaveBeenCalledOnce();
    });

    it("retries a serialization failure, then reports CONFLICT / PINS_BUSY instead of a 500", async () => {
      const serialization = Object.assign(new Error("could not serialize access"), {
        code: "P2034",
      });
      db.$transaction.mockRejectedValueOnce(serialization);
      db.conversation.findFirst.mockResolvedValue({ id: "c1" });
      await expect(client().pin({ id: "c1" })).resolves.toEqual({ pinned: true });
      expect(db.$transaction).toHaveBeenCalledTimes(2);

      db.$transaction.mockReset();
      db.$transaction.mockRejectedValue(serialization);
      await expect(client().pin({ id: "c1" })).rejects.toSatisfy(
        expectReason("CONFLICT", "PINS_BUSY"),
      );
      expect(db.$transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe("unpin", () => {
    it("removes only the caller's own pin, idempotently", async () => {
      await expect(client("user-b").unpin({ id: "c1" })).resolves.toEqual({ pinned: false });
      expect(db.conversationPin.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-b", conversationId: "c1" },
      });
    });
  });

  describe("reorder", () => {
    it("renumbers the caller's pins in the given order", async () => {
      db.conversationPin.findMany.mockResolvedValue([
        { conversationId: "c1" },
        { conversationId: "c2" },
        { conversationId: "c3" },
      ]);
      await expect(client().reorder({ ids: ["c3", "c1", "c2"] })).resolves.toEqual({ ok: true });
      expect(db.conversationPin.deleteMany).toHaveBeenCalledWith({ where: lost("user-a") });
      expect(db.conversationPin.findMany.mock.calls[0]?.[0].where).toEqual(visible("user-a"));
      expect(db.conversationPin.updateMany.mock.calls.map((call) => call[0])).toEqual([
        { where: { userId: "user-a", conversationId: "c3" }, data: { position: 0 } },
        { where: { userId: "user-a", conversationId: "c1" }, data: { position: 1 } },
        { where: { userId: "user-a", conversationId: "c2" }, data: { position: 2 } },
      ]);
    });

    it("refuses an order that names another user's conversation or misses a pin", async () => {
      db.conversationPin.findMany.mockResolvedValue([
        { conversationId: "c1" },
        { conversationId: "c2" },
      ]);
      await expect(client().reorder({ ids: ["c1", "theirs"] })).rejects.toSatisfy(
        expectReason("CONFLICT", "PINS_CHANGED"),
      );
      await expect(client().reorder({ ids: ["c1"] })).rejects.toSatisfy(
        expectReason("CONFLICT", "PINS_CHANGED"),
      );
      await expect(client().reorder({ ids: ["c1", "c2", "c3"] })).rejects.toSatisfy(
        expectReason("CONFLICT", "PINS_CHANGED"),
      );
      expect(db.conversationPin.updateMany).not.toHaveBeenCalled();
    });

    it("rejects duplicates and more than the limit at the boundary", async () => {
      await expect(client().reorder({ ids: ["c1", "c1"] })).rejects.toSatisfy(
        expectReason("BAD_REQUEST"),
      );
      const thirteen = Array.from({ length: 13 }, (_, index) => `c${index}`);
      await expect(client().reorder({ ids: thirteen })).rejects.toSatisfy(
        expectReason("BAD_REQUEST"),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
});
