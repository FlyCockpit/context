import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@cockpit-context/repos", async () => vi.importActual("../../repos/src/locks"));

const { default: prisma } = await import("@cockpit-context/db");
const { MAX_HISTORY_TURNS, MAX_SUMMARY_JOBS_SCANNED, partsFromJson, prismaRunStore } = await import(
  "./store"
);

type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  package: { findFirst: Fn };
  conversation: { findFirst: Fn; create: Fn };
  agentRun: { create: Fn; update: Fn; findFirst: Fn; updateMany: Fn };
  runTurn: { create: Fn; findMany: Fn };
  checkoutLease: { upsert: Fn; deleteMany: Fn; updateMany: Fn };
  checkout: { updateMany: Fn; findFirst: Fn; findUnique: Fn };
  user: { findUnique: Fn };
  checkoutSummaryOverride: { findUnique: Fn; deleteMany: Fn; updateMany: Fn };
  backgroundJob: { findMany: Fn };
  $transaction: Fn;
};

beforeEach(() => {
  vi.clearAllMocks();
  db.checkoutLease.updateMany.mockResolvedValue({ count: 0 });
});

describe("prismaRunStore", () => {
  it("scopes package and conversation reads by owner", async () => {
    db.package.findFirst.mockResolvedValue(null);
    db.conversation.findFirst.mockResolvedValue(null);
    await prismaRunStore.loadPackage("u1", "p1");
    await prismaRunStore.loadConversation("u1", "c1");
    expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({ id: "p1", ownerId: "u1" });
    expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual({ id: "c1", ownerId: "u1" });
  });

  it("writes stored enum spellings and reads back API spellings", async () => {
    db.agentRun.create.mockResolvedValue({ id: "r1" });
    await prismaRunStore.createRun({
      ownerId: "u1",
      conversationId: "c1",
      parentRunId: null,
      checkoutId: "k1",
      kind: "main",
      trigger: "web_message",
      status: "queued",
      model: "m",
      focus: null,
      startedAt: null,
    });
    expect(db.agentRun.create.mock.calls[0]?.[0].data).toMatchObject({
      kind: "MAIN",
      trigger: "WEB_MESSAGE",
      status: "QUEUED",
    });
    db.agentRun.findFirst.mockResolvedValue({
      id: "r1",
      conversationId: "c1",
      kind: "HELPER",
      status: "INTERRUPTED",
      stopReason: null,
      error: null,
      answer: null,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsdMicros: 0,
    });
    await expect(prismaRunStore.getRun("u1", "r1")).resolves.toMatchObject({
      kind: "helper",
      status: "interrupted",
    });
    expect(db.agentRun.findFirst.mock.calls[0]?.[0].where).toEqual({ id: "r1", ownerId: "u1" });
  });

  it("saves turns with the stored role and reads only finished main runs' history", async () => {
    db.runTurn.create.mockResolvedValue({ id: "t1" });
    await prismaRunStore.insertTurn({
      runId: "r1",
      seq: 0,
      role: "tool",
      parts: [{ type: "tool-result", toolCallId: "c", content: "x", state: "done" }],
      steering: false,
    });
    expect(db.runTurn.create.mock.calls[0]?.[0].data).toMatchObject({ role: "TOOL", seq: 0 });

    // Read newest first (so the cap keeps the latest turns), returned oldest first.
    db.runTurn.findMany.mockResolvedValue([
      {
        id: "t2",
        runId: "r1",
        seq: 1,
        role: "ASSISTANT",
        parts: [{ type: "text", content: "a" }],
        steering: false,
      },
      {
        id: "t1",
        runId: "r1",
        seq: 0,
        role: "USER",
        parts: [{ type: "text", content: "q" }],
        steering: true,
      },
    ]);
    await expect(prismaRunStore.listHistoryTurns("c1")).resolves.toEqual([
      {
        id: "t1",
        runId: "r1",
        seq: 0,
        role: "user",
        parts: [{ type: "text", content: "q" }],
        steering: true,
      },
      {
        id: "t2",
        runId: "r1",
        seq: 1,
        role: "assistant",
        parts: [{ type: "text", content: "a" }],
        steering: false,
      },
    ]);
    const args = db.runTurn.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      AgentRun: { conversationId: "c1", kind: "MAIN", status: { notIn: ["QUEUED", "RUNNING"] } },
    });
    expect(args.orderBy).toEqual([
      { AgentRun: { createdAt: "desc" } },
      { runId: "desc" },
      { seq: "desc" },
    ]);
    expect(args.take).toBe(MAX_HISTORY_TURNS);
  });

  it("reports a lease on a vanished checkout as false instead of throwing", async () => {
    db.checkout.findUnique.mockResolvedValue({ repositoryId: "repository-1" });
    db.checkoutLease.upsert.mockRejectedValueOnce(
      Object.assign(new Error("fk"), { code: "P2003" }),
    );
    await expect(prismaRunStore.acquireLease("r1", "k1", new Date())).resolves.toBe(false);
    db.checkoutLease.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(prismaRunStore.acquireLease("r1", "k1", new Date())).rejects.toThrow("db down");
    db.checkoutLease.upsert.mockResolvedValueOnce({ id: "l1" });
    await expect(prismaRunStore.acquireLease("r1", "k1", new Date())).resolves.toBe(true);
  });

  it("releases leases by run and recovers orphans in one transaction", async () => {
    db.checkout.updateMany.mockReturnValueOnce("summary-op");
    db.checkoutLease.deleteMany.mockReturnValue("delete-op");
    db.agentRun.updateMany.mockReturnValue("update-op");
    db.$transaction.mockResolvedValue([{ count: 1 }, { count: 3 }, { count: 2 }]);
    await expect(prismaRunStore.interruptOrphanRuns(new Date(), ["live1"])).resolves.toBe(2);
    expect(db.$transaction).toHaveBeenCalledWith(["summary-op", "delete-op", "update-op"]);
    // A summary left PENDING by an interrupted SUMMARY run can be requested again.
    expect(db.checkout.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        summaryStatus: "PENDING",
        AgentRuns: {
          some: {
            kind: "SUMMARY",
            status: { in: ["QUEUED", "RUNNING"] },
            id: { notIn: ["live1"] },
          },
        },
      },
      data: { summaryStatus: "NONE" },
    });
    expect(db.checkoutLease.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { runId: { notIn: ["live1"] } },
    });
    expect(db.agentRun.updateMany.mock.calls[0]?.[0].where).toEqual({
      status: { in: ["QUEUED", "RUNNING"] },
      id: { notIn: ["live1"] },
    });

    db.checkoutLease.deleteMany.mockResolvedValue({ count: 1 });
    await prismaRunStore.releaseLeases("r1");
    expect(db.checkoutLease.deleteMany.mock.calls[1]?.[0]).toEqual({ where: { runId: "r1" } });
  });

  it("finishes a run only while it is still queued or running", async () => {
    db.agentRun.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const finishedAt = new Date();
    await expect(
      prismaRunStore.finishRunIfActive("r1", {
        status: "failed",
        stopReason: "engine-error",
        finishedAt,
      }),
    ).resolves.toBe(true);
    expect(db.agentRun.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: "r1", status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", stopReason: "engine-error", finishedAt },
    });
    // Already terminal: nothing is overwritten.
    await expect(prismaRunStore.finishRunIfActive("r1", { status: "failed" })).resolves.toBe(false);
  });

  it("closes only the run's still-active helpers", async () => {
    db.agentRun.updateMany.mockResolvedValueOnce({ count: 2 });
    const finishedAt = new Date();
    await expect(
      prismaRunStore.closeActiveHelpers("r1", {
        status: "interrupted",
        stopReason: "interrupted",
        error: null,
        finishedAt,
      }),
    ).resolves.toBe(2);
    expect(db.agentRun.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { parentRunId: "r1", kind: "HELPER", status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "INTERRUPTED", stopReason: "interrupted", error: null, finishedAt },
    });
  });

  it("leaves the helpers still executing in this process alone", async () => {
    db.agentRun.updateMany.mockResolvedValueOnce({ count: 0 });
    const finishedAt = new Date();
    await prismaRunStore.closeActiveHelpers(
      "r1",
      { status: "failed", stopReason: "engine-error", error: "x", finishedAt },
      ["h1", "h2"],
    );
    expect(db.agentRun.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        parentRunId: "r1",
        kind: "HELPER",
        status: { in: ["QUEUED", "RUNNING"] },
        id: { notIn: ["h1", "h2"] },
      },
    });
  });

  it("reads only a checkout's status when that is all it needs", async () => {
    db.checkout.findUnique.mockResolvedValueOnce({ status: "READY" }).mockResolvedValueOnce(null);
    await expect(prismaRunStore.loadCheckoutStatus("k1")).resolves.toBe("ready");
    expect(db.checkout.findUnique.mock.calls[0]?.[0]).toEqual({
      where: { id: "k1" },
      select: { status: true },
    });
    await expect(prismaRunStore.loadCheckoutStatus("k2")).resolves.toBeNull();
  });

  it("resets PENDING summaries with no active summary run and no live summarize job", async () => {
    db.backgroundJob.findMany.mockResolvedValueOnce([
      { payload: { checkoutId: "k1", ownerId: "u1" } },
      { payload: { ownerId: "u1" } },
      { payload: null },
    ]);
    db.checkout.updateMany.mockResolvedValueOnce({ count: 4 });
    await expect(prismaRunStore.resetOrphanSummaries()).resolves.toBe(4);
    const query = db.backgroundJob.findMany.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      where: {
        type: "checkout.summarize",
        OR: [{ status: "queued" }, { status: "running", attempts: { lt: expect.anything() } }],
      },
      select: { payload: true },
      take: MAX_SUMMARY_JOBS_SCANNED,
    });
    expect(db.checkout.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        summaryStatus: "PENDING",
        id: { notIn: ["k1"] },
        AgentRuns: { none: { kind: "SUMMARY", status: { in: ["QUEUED", "RUNNING"] } } },
      },
      data: { summaryStatus: "NONE" },
    });
  });

  it("resets nothing when the summarize jobs read were truncated", async () => {
    db.backgroundJob.findMany.mockResolvedValueOnce(
      Array.from({ length: MAX_SUMMARY_JOBS_SCANNED }, (_, index) => ({
        payload: { checkoutId: `k${index}` },
      })),
    );
    await expect(prismaRunStore.resetOrphanSummaries()).resolves.toBe(0);
    expect(db.checkout.updateMany).not.toHaveBeenCalled();
  });

  it("lets only an existing, unarchived owner run", async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    db.user.findUnique
      .mockResolvedValueOnce({ banned: false, banExpires: null })
      .mockResolvedValueOnce({ banned: null, banExpires: null })
      .mockResolvedValueOnce({ banned: true, banExpires: null })
      .mockResolvedValueOnce({ banned: true, banExpires: future })
      .mockResolvedValueOnce({ banned: true, banExpires: past })
      .mockResolvedValueOnce(null);
    const results = [];
    for (let index = 0; index < 6; index += 1) results.push(await prismaRunStore.ownerMayRun("u1"));
    expect(results).toEqual([true, true, false, false, true, false]);
    expect(db.user.findUnique.mock.calls[0]?.[0].where).toEqual({ id: "u1" });
  });

  it("checks checkout ownership through the user's packages on its repository", async () => {
    db.checkout.findFirst.mockResolvedValueOnce({ id: "k1" }).mockResolvedValueOnce(null);
    await expect(prismaRunStore.ownsCheckout("u1", "k1", "p1")).resolves.toBe(true);
    expect(db.checkout.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: "k1",
      Repository: { Packages: { some: { ownerId: "u1", id: "p1" } } },
    });
    await expect(prismaRunStore.ownsCheckout("u2", "k1")).resolves.toBe(false);
    expect(db.checkout.findFirst.mock.calls[1]?.[0].where).toEqual({
      id: "k1",
      Repository: { Packages: { some: { ownerId: "u2" } } },
    });
  });

  it("moves the generated summary conditionally and never touches overrides", async () => {
    db.checkout.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(prismaRunStore.markSummaryPending("k1", ["none", "ready"])).resolves.toBe(true);
    // Status only: the previous generated text stays readable meanwhile.
    expect(db.checkout.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: "k1", summaryStatus: { in: ["NONE", "READY"] } },
      data: { summaryStatus: "PENDING" },
    });
    await expect(
      prismaRunStore.finishSummary("k1", {
        status: "ready",
        summary: "s",
        model: "m",
        generatedAt: new Date(0),
      }),
    ).resolves.toBe(false);
    expect(db.checkout.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "k1", summaryStatus: "PENDING" },
      data: {
        summaryStatus: "READY",
        summary: "s",
        summaryModel: "m",
        summaryGeneratedAt: new Date(0),
      },
    });
    expect(db.checkoutSummaryOverride.deleteMany).not.toHaveBeenCalled();
    expect(db.checkoutSummaryOverride.updateMany).not.toHaveBeenCalled();

    db.checkout.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(prismaRunStore.markSummaryPending("k1", ["none"])).resolves.toBe(false);
  });

  it("loads only the run owner's override", async () => {
    db.checkoutSummaryOverride.findUnique
      .mockResolvedValueOnce({ body: "Mine" })
      .mockResolvedValueOnce(null);
    await expect(prismaRunStore.loadSummaryOverride("k1", "u1")).resolves.toBe("Mine");
    expect(db.checkoutSummaryOverride.findUnique.mock.calls[0]?.[0]).toEqual({
      where: { checkoutId_userId: { checkoutId: "k1", userId: "u1" } },
      select: { body: true },
    });
    await expect(prismaRunStore.loadSummaryOverride("k1", "u2")).resolves.toBeNull();
  });
});

describe("partsFromJson", () => {
  it("keeps typed part objects and drops anything else", () => {
    expect(
      partsFromJson([{ type: "text", content: "a" }, "x", null, { content: "no type" }, [1]]),
    ).toEqual([{ type: "text", content: "a" }]);
    expect(partsFromJson({ type: "text" })).toEqual([]);
  });
});
