import { createEventBus } from "@cockpit-context/jobs/event-bus";
import type { LiveConversationState, RunActivityEvent, RunEvent } from "@cockpit-context/runs";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
const envMock = vi.hoisted(() => ({
  COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90,
  COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER: 20,
}));
vi.mock("@cockpit-context/env/server", async () => {
  // The Cockpit Context rate budgets at their defaults: the run and steer budgets read them on first consume.
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  Object.assign(envMock, cockpitContextRateBudgetEnvDefaults());
  return { env: envMock, ADMIN_EMAILS: new Set<string>() };
});

const bus = createEventBus<RunEvent>({ name: "test-runs" });
const activity = createEventBus<RunActivityEvent>({ name: "test-activity" });
const engine = {
  bus,
  activity,
  liveState: vi.fn<() => LiveConversationState>(() => ({ runs: [] })),
  startConversation: vi.fn(),
  openConversation: vi.fn(),
  retryConversation: vi.fn(),
  sendMessage: vi.fn(),
  steer: vi.fn(),
  stop: vi.fn(),
};
vi.mock("@cockpit-context/runs", async () => ({
  getRunEngine: () => engine,
  partsFromJson: (value: unknown) => (Array.isArray(value) ? value : []),
  runFailureFromJson: (await import("@cockpit-context/runs/failure")).runFailureFromJson,
}));

const { default: prisma } = await import("@cockpit-context/db");
const { RunEngineError } = await import("@cockpit-context/runs/errors");
const { conversationsRouter } = await import("./conversations");
const { announceUserBanned } = await import("@cockpit-context/auth/ban");
const { liveStreamCount } = await import("../lib/live-streams");

const db = prisma as unknown as {
  conversation: { findMany: MockInstance; findFirst: MockInstance; deleteMany: MockInstance };
  agentRun: { findMany: MockInstance; groupBy: MockInstance };
  runTurn: { findMany: MockInstance };
  package: { findFirst: MockInstance };
  user: { findUnique: MockInstance };
};

const NOW = new Date("2026-10-01T00:00:00Z");

function conversationRow(
  id: string,
  status = "COMPLETED",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    createdAt: NOW,
    title: "How do I retry?",
    packageId: "pkg-1",
    packageIdentifier: "pypi:requests",
    requestedVersion: "2.32.0",
    requestedRef: null,
    commitSha: "c".repeat(40),
    resolvedFrom: "tag:v2.32.0",
    checkoutId: "co-1",
    origin: "MCP",
    mcpConnectionLabel: "Claude Code",
    lastActivityAt: NOW,
    AgentRuns: [
      {
        id: `run-${id}`,
        status,
        iterations: 3,
        startedAt: NOW,
        finishedAt: null,
        stopReason: null,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costUsdMicros: 1500,
      },
    ],
    _count: { AgentRuns: status === "QUEUED" || status === "RUNNING" ? 1 : 0 },
    ...overrides,
  };
}

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(conversationsRouter, { context });
}

function expectReason(code: string, reason?: string) {
  return (error: ORPCError<string, { reason?: string }>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
    return true;
  };
}

const ownedBy = (id: string, ownerId: string) => ({ AND: [{ id }, { ownerId }] });

describe("conversationsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine.liveState.mockReturnValue({ runs: [] });
    db.agentRun.groupBy.mockResolvedValue([]);
    db.agentRun.findMany.mockResolvedValue([]);
    db.runTurn.findMany.mockResolvedValue([]);
    // The live-stream registry re-reads the ban state on every open.
    db.user.findUnique.mockResolvedValue({ banned: false, banExpires: null });
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).list({})).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
  });

  describe("list", () => {
    it("puts ongoing conversations first, then fills the page with finished ones", async () => {
      db.conversation.findMany
        .mockResolvedValueOnce([conversationRow("c-live", "RUNNING")])
        .mockResolvedValueOnce([conversationRow("c-old-1"), conversationRow("c-old-2")]);
      db.agentRun.groupBy.mockResolvedValue([
        { conversationId: "c-live", _sum: { costUsdMicros: 4200, unpricedCalls: 2 } },
      ]);
      const result = await client().list({ limit: 2 });

      const [ongoing, finished] = db.conversation.findMany.mock.calls.map((call) => call[0]);
      expect(ongoing.where).toEqual({
        AND: [
          {
            AND: [
              { ownerId: "user-a" },
              { AgentRuns: { some: { kind: "MAIN", status: { in: ["QUEUED", "RUNNING"] } } } },
            ],
          },
        ],
      });
      expect(ongoing.take).toBe(3);
      expect(finished.where.AND[0].AND[1]).toEqual({
        AgentRuns: { none: { kind: "MAIN", status: { in: ["QUEUED", "RUNNING"] } } },
      });
      // One slot left after the single ongoing row: take = 1 + 1 lookahead.
      expect(finished.take).toBe(2);

      expect(result.items.map((item) => [item.id, item.ongoing])).toEqual([
        ["c-live", true],
        ["c-old-1", false],
      ]);
      expect(result.items[0]?.totalCostUsdMicros).toBe(4200);
      expect(result.items[0]?.totalUnpricedCalls).toBe(2);
      // A conversation with no runs summed reads as nothing spent, nothing unpriced.
      expect(result.items[1]).toMatchObject({ totalCostUsdMicros: 0, totalUnpricedCalls: 0 });
      expect(db.agentRun.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ _sum: { costUsdMicros: true, unpricedCalls: true } }),
      );
      expect(result.items[0]?.origin).toBe("mcp");
      expect(result.next).toEqual({ segment: "finished", cursor: expect.any(String) });
      expect(db.agentRun.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: "user-a", conversationId: { in: ["c-live", "c-old-1"] } },
        }),
      );
    });

    it("continues within the ongoing segment while it has more", async () => {
      db.conversation.findMany.mockResolvedValueOnce([
        conversationRow("c-1", "RUNNING"),
        conversationRow("c-2", "QUEUED"),
      ]);
      const result = await client().list({ limit: 1 });
      expect(db.conversation.findMany).toHaveBeenCalledTimes(1);
      expect(result.next).toEqual({ segment: "ongoing", cursor: expect.any(String) });
    });

    it("signals a finished segment when ongoing filled the page exactly", async () => {
      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-1", "RUNNING")]);
      db.conversation.findFirst.mockResolvedValueOnce({ id: "c-old" });
      const result = await client().list({ limit: 1 });
      expect(result.next).toEqual({ segment: "finished", cursor: null });
    });

    it("accepts its own `next` token back unchanged, including a null cursor", async () => {
      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-1", "RUNNING")]);
      db.conversation.findFirst.mockResolvedValueOnce({ id: "c-old" });
      const first = await client().list({ limit: 1 });
      expect(first.next).toEqual({ segment: "finished", cursor: null });
      if (!first.next) throw new Error("expected a next token");

      db.conversation.findMany.mockResolvedValueOnce([
        conversationRow("c-old"),
        conversationRow("c-older"),
      ]);
      const second = await client().list({ limit: 1, ...first.next });
      // A null cursor is the first page of the finished segment: no keyset bound.
      const call = db.conversation.findMany.mock.calls[1]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            AND: [
              { ownerId: "user-a" },
              { AgentRuns: { none: { kind: "MAIN", status: { in: ["QUEUED", "RUNNING"] } } } },
            ],
          },
        ],
      });
      expect(second.items.map((item) => item.id)).toEqual(["c-old"]);
      expect(second.next).toEqual({ segment: "finished", cursor: expect.any(String) });
      if (!second.next) throw new Error("expected a next token");

      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-older")]);
      const third = await client().list({ limit: 1, ...second.next });
      expect(third.items.map((item) => item.id)).toEqual(["c-older"]);
      expect(third.next).toBeNull();
    });

    it("derives the ongoing flag from the same rule as the segment", async () => {
      // The latest main run finished, but an older main run is still active.
      db.conversation.findMany.mockResolvedValueOnce([
        conversationRow("c-stale", "COMPLETED", { _count: { AgentRuns: 1 } }),
      ]);
      db.conversation.findFirst.mockResolvedValueOnce(null);
      const result = await client().list({ limit: 1 });
      expect(result.items[0]?.ongoing).toBe(true);
      expect(db.conversation.findMany.mock.calls[0]?.[0].select._count).toEqual({
        select: {
          AgentRuns: { where: { kind: "MAIN", status: { in: ["QUEUED", "RUNNING"] } } },
        },
      });
    });

    it("pages the finished segment by its cursor and filters by origin", async () => {
      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-old")]);
      const result = await client().list({ segment: "finished", origin: "web" });
      expect(db.conversation.findMany).toHaveBeenCalledTimes(1);
      expect(db.conversation.findMany.mock.calls[0]?.[0].where.AND[0].AND[0]).toEqual({
        ownerId: "user-a",
        origin: "WEB",
      });
      expect(result.next).toBeNull();
    });

    it("searches titles case-insensitively, trimmed, alongside the other filters", async () => {
      db.conversation.findMany
        .mockResolvedValueOnce([conversationRow("c-live", "RUNNING")])
        .mockResolvedValueOnce([]);
      await client().list({ limit: 2, search: "  Router  ", packageId: "p-1", origin: "mcp" });
      const expectedBase = {
        ownerId: "user-a",
        packageId: "p-1",
        origin: "MCP",
        title: { contains: "Router", mode: "insensitive" },
      };
      const [ongoing, finished] = db.conversation.findMany.mock.calls.map((call) => call[0]);
      // Both segments carry the search, so the keyset never crosses into unmatched rows.
      expect(ongoing.where.AND[0].AND[0]).toEqual(expectedBase);
      expect(finished.where.AND[0].AND[0]).toEqual(expectedBase);
    });

    it("applies the search to the finished-segment probe too", async () => {
      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-1", "RUNNING")]);
      db.conversation.findFirst.mockResolvedValueOnce(null);
      const result = await client().list({ limit: 1, search: "router" });
      expect(db.conversation.findFirst.mock.calls[0]?.[0].where.AND[0]).toEqual({
        ownerId: "user-a",
        title: { contains: "router", mode: "insensitive" },
      });
      expect(result.next).toBeNull();
    });

    it("treats a blank search as no filter", async () => {
      db.conversation.findMany.mockResolvedValueOnce([conversationRow("c-old")]);
      await client().list({ segment: "finished", search: "   " });
      expect(db.conversation.findMany.mock.calls[0]?.[0].where.AND[0].AND[0]).toEqual({
        ownerId: "user-a",
      });
    });

    it("rejects a search longer than 200 characters", async () => {
      await expect(client().list({ search: "x".repeat(201) })).rejects.toSatisfy(
        expectReason("BAD_REQUEST"),
      );
      expect(db.conversation.findMany).not.toHaveBeenCalled();
      // The bound applies after trimming: padding around 200 characters is fine.
      db.conversation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await client().list({ search: ` ${"x".repeat(200)} ` });
      expect(db.conversation.findMany).toHaveBeenCalled();
    });
  });

  describe("get", () => {
    it("returns the commit's https source: the checkout's public repository, else the package URL", async () => {
      db.agentRun.findMany.mockResolvedValue([]);
      db.runTurn.findMany.mockResolvedValue([]);
      const source = async (overrides: Record<string, unknown>) => {
        db.conversation.findFirst.mockResolvedValueOnce(
          conversationRow("c-1", "COMPLETED", overrides),
        );
        return (await client().get({ id: "c-1" })).sourceUrl;
      };
      expect(
        await source({
          Checkout: {
            Repository: { remoteUrl: "https://github.com/psf/requests", visibility: "PUBLIC" },
          },
        }),
      ).toBe("https://github.com/psf/requests");
      // No checkout (unresolved or pruned): no source, whatever the package says now.
      expect(await source({ Checkout: null })).toBeNull();
      // A private clone never links, even if its URL were https.
      expect(
        await source({
          Checkout: {
            Repository: { remoteUrl: "https://github.com/me/private", visibility: "PRIVATE" },
          },
        }),
      ).toBeNull();
      expect(
        await source({
          Checkout: {
            Repository: { remoteUrl: "git@github.com:me/private.git", visibility: "PRIVATE" },
          },
        }),
      ).toBeNull();
      const select = db.conversation.findFirst.mock.calls[0]?.[0].select;
      expect(select.Checkout).toEqual({
        select: { Repository: { select: { remoteUrl: true, visibility: true } } },
      });
      expect(select).not.toHaveProperty("Package");
    });

    it("shows a run's failure allowlisted, never its server-side error text", async () => {
      db.conversation.findFirst.mockResolvedValue(
        conversationRow("c-2", "FAILED", { commitSha: null, resolvedFrom: null, checkoutId: null }),
      );
      db.agentRun.findMany.mockResolvedValue([
        {
          id: "run-1",
          createdAt: NOW,
          parentRunId: null,
          kind: "MAIN",
          status: "FAILED",
          trigger: "WEB_MESSAGE",
          model: "m",
          focus: null,
          stopReason: "resolve-failed",
          failure: { reason: "VERSION_NOT_FOUND", nearestTags: ["v2.32.1"], stderr: "fatal: x" },
          iterations: 0,
          startedAt: null,
          finishedAt: NOW,
          answer: null,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsdMicros: 0,
          unpricedCalls: 0,
        },
      ]);
      db.runTurn.findMany.mockResolvedValue([]);
      db.agentRun.groupBy.mockResolvedValue([] as never);
      const detail = await client().get({ id: "c-2" });
      expect(detail.commitSha).toBeNull();
      expect(detail.checkoutAvailable).toBe(false);
      expect(detail.runs[0]?.failure).toEqual({
        reason: "VERSION_NOT_FOUND",
        nearestTags: ["v2.32.1"],
      });
      expect(JSON.stringify(detail)).not.toContain("fatal");
      // `error` is never selected.
      expect(db.agentRun.findMany.mock.calls[0]?.[0].select).not.toHaveProperty("error");
    });

    it("loads runs and turns owner-scoped at every level", async () => {
      db.conversation.findFirst.mockResolvedValue(conversationRow("c-1"));
      db.agentRun.findMany.mockResolvedValue([
        {
          id: "run-1",
          createdAt: NOW,
          parentRunId: null,
          kind: "MAIN",
          status: "COMPLETED",
          trigger: "MCP_QUERY",
          model: "m",
          focus: null,
          stopReason: "completed",
          iterations: 3,
          startedAt: NOW,
          finishedAt: NOW,
          answer: "Use HTTPAdapter(max_retries=…)",
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 0,
          costUsdMicros: 700,
        },
      ]);
      db.runTurn.findMany.mockResolvedValue([
        {
          runId: "run-1",
          seq: 1,
          role: "ASSISTANT",
          parts: [{ type: "text", text: "b" }],
          steering: false,
          createdAt: NOW,
        },
        {
          runId: "run-1",
          seq: 0,
          role: "USER",
          parts: [{ type: "text", text: "a" }],
          steering: false,
          createdAt: NOW,
        },
      ]);
      db.agentRun.groupBy.mockResolvedValue([
        { conversationId: "c-1", _sum: { costUsdMicros: 1700 } },
      ]);
      const result = await client().get({ id: "c-1" });
      expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual(ownedBy("c-1", "user-a"));
      expect(db.agentRun.findMany.mock.calls[0]?.[0].where).toEqual({
        conversationId: "c-1",
        ownerId: "user-a",
      });
      expect(db.runTurn.findMany.mock.calls[0]?.[0].where).toEqual({ runId: { in: ["run-1"] } });
      expect(result.runs[0]?.turns.map((turn) => [turn.seq, turn.role])).toEqual([
        [0, "user"],
        [1, "assistant"],
      ]);
      expect(result.totalCostUsdMicros).toBe(1700);
      expect(db.agentRun.findMany.mock.calls[0]?.[0]).toMatchObject({
        take: 200,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      expect(db.runTurn.findMany.mock.calls[0]?.[0]).toMatchObject({
        take: 5000,
        orderBy: [{ createdAt: "desc" }, { runId: "desc" }, { seq: "desc" }],
      });
      // Error text stays server-side (it can carry provider output).
      expect(result.runs[0]).not.toHaveProperty("error");
      expect(db.agentRun.findMany.mock.calls[0]?.[0].select).not.toHaveProperty("error");
    });

    it("reserves room for an older live main alongside the newest bounded history", async () => {
      db.conversation.findFirst.mockResolvedValue(conversationRow("c-1", "RUNNING"));
      const usage = { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, costUsdMicros: 700 };
      const run = (id: string, createdAt: Date, kind = "HELPER") => ({
        id,
        createdAt,
        parentRunId: kind === "MAIN" ? null : "live-old",
        kind,
        status: kind === "MAIN" ? "RUNNING" : "COMPLETED",
        trigger: "MCP_QUERY",
        model: "m",
        focus: null,
        stopReason: null,
        iterations: 1,
        startedAt: createdAt,
        finishedAt: null,
        answer: null,
        ...usage,
      });
      engine.liveState.mockReturnValue({
        runs: [
          {
            runId: "live-old",
            parentRunId: null,
            kind: "main",
            phase: "running",
            iterations: 1,
            usage,
            partial: null,
          },
        ],
      });
      db.agentRun.findMany
        .mockResolvedValueOnce([run("live-old", new Date(0), "MAIN")])
        .mockResolvedValueOnce(Array.from({ length: 199 }, (_, n) => run(`helper-${n}`, NOW)));
      db.agentRun.groupBy.mockResolvedValue([
        { conversationId: "c-1", _sum: { costUsdMicros: 300000 } },
      ]);
      const result = await client().get({ id: "c-1" });
      expect(result.runs).toHaveLength(200);
      expect(result.runs[0]).toMatchObject({ id: "live-old", status: "running" });
      expect(result.totalCostUsdMicros).toBe(300000);
      expect(result.truncated).toBe(true);
      expect(db.agentRun.findMany.mock.calls[1]?.[0]).toMatchObject({
        take: 199,
        where: { id: { notIn: ["live-old"] } },
      });
    });

    it("is NOT_FOUND for another user's conversation", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      await expect(client(sessionContext({ id: "user-b" })).get({ id: "c-1" })).rejects.toSatisfy(
        expectReason("NOT_FOUND"),
      );
      expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual(ownedBy("c-1", "user-b"));
      expect(db.agentRun.findMany).not.toHaveBeenCalled();
    });
  });

  describe("watch", () => {
    it("checks ownership before subscribing", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      const iterator = await client(sessionContext({ id: "user-b" })).watch({ id: "c-1" });
      await expect(iterator.next()).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(bus.listenerCount("c-1")).toBe(0);
    });

    it("sends a snapshot, then live events, including ones published while the snapshot loaded", async () => {
      db.conversation.findFirst
        .mockResolvedValueOnce({ id: "c-1" })
        .mockResolvedValueOnce(conversationRow("c-1", "RUNNING"));
      const early: RunEvent = { type: "run.phase", runId: "run-c-1", phase: "running" };
      db.agentRun.findMany.mockImplementation(async () => {
        // Published between the subscription and the snapshot read.
        bus.publish("c-1", early);
        return [];
      });
      engine.liveState.mockReturnValue({ runs: [] });

      const iterator = await client().watch({ id: "c-1" });
      const first = await iterator.next();
      expect(first.value).toMatchObject({
        type: "snapshot",
        conversation: { id: "c-1", ongoing: true, runs: [] },
        live: { runs: [] },
      });
      expect(engine.liveState).toHaveBeenCalledWith("user-a", "c-1");

      const second = await iterator.next();
      expect(second.value).toEqual(early);

      const live: RunEvent = {
        type: "run.finished",
        runId: "run-c-1",
        status: "completed",
        stopReason: "completed",
        answer: "done",
        error: null,
      };
      const pending = iterator.next();
      bus.publish("c-1", live);
      const { error: _error, ...relayed } = live;
      expect((await pending).value).toEqual({ ...relayed, sourceUrl: null });

      await iterator.return?.();
      expect(bus.listenerCount("c-1")).toBe(0);
    });

    it("relays run.finished without its error text", async () => {
      db.conversation.findFirst
        .mockResolvedValueOnce({ id: "c-1" })
        .mockResolvedValueOnce(conversationRow("c-1", "RUNNING"));
      const iterator = await client().watch({ id: "c-1" });
      await iterator.next();

      const pending = iterator.next();
      bus.publish("c-1", {
        type: "run.finished",
        runId: "run-c-1",
        status: "failed",
        stopReason: "checkout-failed",
        answer: null,
        error: "GIT_FAILED: git fetch failed: fatal: /var/lib/cockpit-context/keys/tmp-123 denied",
      });
      const relayed = (await pending).value;
      expect(relayed).toEqual({
        type: "run.finished",
        runId: "run-c-1",
        status: "failed",
        stopReason: "checkout-failed",
        answer: null,
        sourceUrl: null,
      });
      expect(relayed).not.toHaveProperty("error");

      await iterator.return?.();
    });

    it("adds the owner-scoped public source to conversation.resolved", async () => {
      db.conversation.findFirst
        .mockResolvedValueOnce({ id: "c-1" })
        .mockResolvedValueOnce(conversationRow("c-1", "RUNNING", { Checkout: null }))
        .mockResolvedValueOnce({
          Checkout: {
            Repository: { remoteUrl: "https://github.com/psf/requests", visibility: "PUBLIC" },
          },
        })
        .mockResolvedValueOnce({
          Checkout: {
            Repository: { remoteUrl: "git@github.com:me/private.git", visibility: "PRIVATE" },
          },
        });
      const iterator = await client().watch({ id: "c-1" });
      expect((await iterator.next()).value).toMatchObject({
        type: "snapshot",
        conversation: { sourceUrl: null },
      });
      const resolved = {
        type: "conversation.resolved" as const,
        runId: "run-c-1",
        commitSha: "a".repeat(40),
        resolvedFrom: "tag:v2.32.3",
        stale: false,
      };
      let pending = iterator.next();
      bus.publish("c-1", resolved);
      expect((await pending).value).toEqual({
        ...resolved,
        sourceUrl: "https://github.com/psf/requests",
      });
      expect(db.conversation.findFirst.mock.calls[2]?.[0].where).toEqual({
        id: "c-1",
        ownerId: "user-a",
      });
      pending = iterator.next();
      bus.publish("c-1", resolved);
      expect((await pending).value).toEqual({ ...resolved, sourceUrl: null });

      // A finished run re-reads it (a follow-up may have re-created a pruned checkout).
      db.conversation.findFirst.mockResolvedValueOnce({
        Checkout: {
          Repository: { remoteUrl: "https://github.com/psf/requests", visibility: "PUBLIC" },
        },
      });
      pending = iterator.next();
      bus.publish("c-1", {
        type: "run.finished",
        runId: "run-c-2",
        status: "completed",
        stopReason: "completed",
        answer: "done",
        error: null,
      });
      expect((await pending).value).toMatchObject({
        type: "run.finished",
        sourceUrl: "https://github.com/psf/requests",
      });

      await iterator.return?.();
    });
  });

  describe("activity", () => {
    it("rejects an anonymous caller without subscribing", async () => {
      await expect(client(anonymousContext).activity()).rejects.toSatisfy(
        expectReason("UNAUTHORIZED"),
      );
      expect(activity.listenerCount("user-a")).toBe(0);
    });

    it("relays only the caller's own topic, after a ready marker", async () => {
      const iterator = await client().activity();
      expect((await iterator.next()).value).toEqual({ type: "ready" });
      expect(activity.listenerCount("user-a")).toBe(1);

      const pending = iterator.next();
      activity.publish("user-b", { conversationId: "c-9", runId: "r-9", change: "progress" });
      activity.publish("user-a", { conversationId: "c-1", runId: "r-1", change: "finished" });
      expect((await pending).value).toEqual({
        type: "activity",
        conversationId: "c-1",
        runId: "r-1",
        change: "finished",
      });

      await iterator.return?.();
      expect(activity.listenerCount("user-a")).toBe(0);
    });
  });

  describe("live-stream cap", () => {
    async function openActivity(userId = "user-a", signal?: AbortSignal) {
      const iterator = await client(sessionContext({ id: userId })).activity(undefined, {
        signal,
      });
      expect((await iterator.next()).value).toEqual({ type: "ready" });
      return iterator;
    }

    async function openWatch(signal?: AbortSignal) {
      db.conversation.findFirst
        .mockResolvedValueOnce({ id: "c-1" })
        .mockResolvedValueOnce(conversationRow("c-1", "RUNNING"));
      const iterator = await client().watch({ id: "c-1" }, { signal });
      expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });
      return iterator;
    }

    it("refuses a stream past the per-user cap across watch and activity, and frees slots on return", async () => {
      const MAX_LIVE_STREAMS_PER_USER = envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER;
      const open = [await openWatch()];
      while (open.length < MAX_LIVE_STREAMS_PER_USER) open.push(await openActivity());

      const refusedActivity = await client().activity();
      await expect(refusedActivity.next()).rejects.toSatisfy(expectReason("TOO_MANY_REQUESTS"));
      db.conversation.findFirst.mockResolvedValueOnce({ id: "c-1" });
      const refusedWatch = await client().watch({ id: "c-1" });
      await expect(refusedWatch.next()).rejects.toSatisfy(expectReason("TOO_MANY_REQUESTS"));
      // A refused stream never subscribes.
      expect(activity.listenerCount("user-a")).toBe(MAX_LIVE_STREAMS_PER_USER - 1);
      expect(bus.listenerCount("c-1")).toBe(1);

      // Another user's slots are their own.
      const other = await openActivity("user-b");
      await other.return?.();

      await open.pop()?.return?.();
      const reopened = await openActivity();
      open.push(reopened);

      for (const iterator of open) await iterator.return?.();
      expect(activity.listenerCount("user-a")).toBe(0);
      expect(bus.listenerCount("c-1")).toBe(0);
      // Every slot is back: a full set opens again.
      const again = [];
      while (again.length < MAX_LIVE_STREAMS_PER_USER) again.push(await openActivity());
      for (const iterator of again) await iterator.return?.();
    });

    it("frees the slot when the client aborts while the stream waits for events", async () => {
      const MAX_LIVE_STREAMS_PER_USER = envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER;
      const controller = new AbortController();
      const aborted = await openWatch(controller.signal);
      const waiting = aborted.next();
      const open = [];
      while (open.length < MAX_LIVE_STREAMS_PER_USER - 1) open.push(await openActivity());
      await expect((await client().activity()).next()).rejects.toSatisfy(
        expectReason("TOO_MANY_REQUESTS"),
      );

      controller.abort();
      await waiting.catch(() => {});
      await vi.waitFor(() => expect(bus.listenerCount("c-1")).toBe(0));
      open.push(await openActivity());

      for (const iterator of open) await iterator.return?.();
    });

    it("frees the slot when the stream fails before its first event", async () => {
      const MAX_LIVE_STREAMS_PER_USER = envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER;
      for (let attempt = 0; attempt <= MAX_LIVE_STREAMS_PER_USER; attempt += 1) {
        db.conversation.findFirst.mockResolvedValueOnce({ id: "c-1" });
        db.conversation.findFirst.mockRejectedValueOnce(new Error("db down"));
        const iterator = await client().watch({ id: "c-1" });
        await expect(iterator.next()).rejects.toThrow();
      }
      expect(bus.listenerCount("c-1")).toBe(0);
      const ok = await openActivity();
      await ok.return?.();
    });

    it("reads the cap from COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER on each open", async () => {
      const original = envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER;
      const open = [];
      try {
        envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER = 2;
        open.push(await openActivity(), await openActivity());
        await expect((await client().activity()).next()).rejects.toSatisfy(
          expectReason("TOO_MANY_REQUESTS"),
        );
        envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER = 3;
        open.push(await openActivity());
      } finally {
        envMock.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER = original;
        for (const iterator of open) await iterator.return?.();
      }
    });
  });

  describe("ban closes live streams", () => {
    async function openActivity(userId = "user-a") {
      const iterator = await client(sessionContext({ id: userId })).activity();
      expect((await iterator.next()).value).toEqual({ type: "ready" });
      return iterator;
    }

    async function openWatch() {
      db.conversation.findFirst
        .mockResolvedValueOnce({ id: "c-1" })
        .mockResolvedValueOnce(conversationRow("c-1", "RUNNING"));
      const iterator = await client().watch({ id: "c-1" });
      expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });
      return iterator;
    }

    it("ends the user's open watch and activity with UNAUTHORIZED, and only theirs", async () => {
      const watch = await openWatch();
      const feed = await openActivity();
      const other = await openActivity("user-b");
      const watchNext = watch.next();
      const feedNext = feed.next();
      expect(liveStreamCount("user-a")).toBe(2);

      announceUserBanned("user-a");

      await expect(watchNext).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
      await expect(feedNext).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
      expect(bus.listenerCount("c-1")).toBe(0);
      expect(activity.listenerCount("user-a")).toBe(0);
      expect(liveStreamCount("user-a")).toBe(0);

      // Another user's stream is untouched and still relays.
      const pending = other.next();
      activity.publish("user-b", { conversationId: "c-2", runId: "r-2", change: "finished" });
      expect((await pending).value).toMatchObject({ type: "activity", conversationId: "c-2" });
      await other.return?.();
      expect(liveStreamCount("user-b")).toBe(0);
    });

    it("delivers nothing the bus had buffered once the ban lands", async () => {
      const feed = await openActivity();
      // Published while the client is not reading: the bus buffers them.
      activity.publish("user-a", { conversationId: "c-1", runId: "r-1", change: "progress" });
      activity.publish("user-a", { conversationId: "c-1", runId: "r-1", change: "finished" });
      announceUserBanned("user-a");
      await expect(feed.next()).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
      expect(liveStreamCount("user-a")).toBe(0);
    });

    it("ends a watch whose snapshot read is still pending, without sending the snapshot", async () => {
      let finishRead: (value: unknown) => void = () => {};
      db.conversation.findFirst.mockResolvedValueOnce({ id: "c-1" }).mockReturnValueOnce(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
      const watch = await client().watch({ id: "c-1" });
      const first = watch.next();
      await vi.waitFor(() => expect(liveStreamCount("user-a")).toBe(1));
      await vi.waitFor(() => expect(db.conversation.findFirst).toHaveBeenCalledTimes(2));
      announceUserBanned("user-a");
      await expect(first).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
      expect(liveStreamCount("user-a")).toBe(0);
      expect(bus.listenerCount("c-1")).toBe(0);
      // The late result goes nowhere.
      finishRead(conversationRow("c-1", "RUNNING"));
    });

    it("refuses to open a stream for a user the database says is banned", async () => {
      // The session that admitted the request can be a cookie-cache copy from
      // before the ban; the registry's own read is what refuses it.
      db.user.findUnique.mockResolvedValue({ banned: true, banExpires: null });
      await expect((await client().activity()).next()).rejects.toSatisfy(
        expectReason("UNAUTHORIZED"),
      );
      db.conversation.findFirst.mockResolvedValueOnce({ id: "c-1" });
      await expect((await client().watch({ id: "c-1" })).next()).rejects.toSatisfy(
        expectReason("UNAUTHORIZED"),
      );
      expect(activity.listenerCount("user-a")).toBe(0);
      expect(bus.listenerCount("c-1")).toBe(0);
      expect(liveStreamCount("user-a")).toBe(0);
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-a" },
        select: { banned: true, banExpires: true },
      });
    });

    it("refuses a deleted user, and admits a lapsed temporary ban", async () => {
      db.user.findUnique.mockResolvedValueOnce(null);
      await expect((await client().activity()).next()).rejects.toSatisfy(
        expectReason("UNAUTHORIZED"),
      );
      db.user.findUnique.mockResolvedValueOnce({
        banned: true,
        banExpires: new Date(Date.now() - 60_000),
      });
      const iterator = await openActivity();
      await iterator.return?.();
      expect(liveStreamCount("user-a")).toBe(0);
    });

    it("refuses a stream whose ban is announced while its ban-state read is in flight", async () => {
      let resolveRead: (value: unknown) => void = () => {};
      db.user.findUnique.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
      );
      const iterator = await client().activity();
      const first = iterator.next();
      await vi.waitFor(() => expect(liveStreamCount("user-a")).toBe(1));
      // The read started before the ban committed and returns the old state.
      announceUserBanned("user-a");
      resolveRead({ banned: false, banExpires: null });
      await expect(first).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
      expect(activity.listenerCount("user-a")).toBe(0);
      expect(liveStreamCount("user-a")).toBe(0);
    });

    it("frees the slot when the ban-state read fails, and fails closed", async () => {
      db.user.findUnique.mockRejectedValueOnce(new Error("db down"));
      await expect((await client().activity()).next()).rejects.toThrow();
      expect(liveStreamCount("user-a")).toBe(0);
      expect(activity.listenerCount("user-a")).toBe(0);
    });

    it("a client disconnect is still a normal end, not UNAUTHORIZED", async () => {
      const iterator = await openActivity();
      await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
      expect(liveStreamCount("user-a")).toBe(0);
    });
  });

  describe("create", () => {
    it("opens a web conversation on an own package at once, leaving resolution to its run", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
      engine.openConversation.mockResolvedValue({ conversationId: "c-new", runId: "run-new" });
      await expect(
        client().create({ packageId: "pkg-1", text: "How do sessions work?", version: "1.0.0" }),
      ).resolves.toEqual({ conversationId: "c-new", runId: "run-new" });
      expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual(ownedBy("pkg-1", "user-a"));
      expect(engine.openConversation).toHaveBeenCalledWith({
        ownerId: "user-a",
        packageId: "pkg-1",
        text: "How do sessions work?",
        version: "1.0.0",
        ref: null,
        origin: "web",
      });
      // The request's signal is never handed over: the clone is not the request's.
      expect(engine.openConversation.mock.calls[0]?.[0]).not.toHaveProperty("signal");
      expect(engine.startConversation).not.toHaveBeenCalled();
    });

    it("is NOT_FOUND for another user's package and never starts a run", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).create({ packageId: "pkg-1", text: "q" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(engine.openConversation).not.toHaveBeenCalled();
    });

    it("refuses a version and a ref together", async () => {
      await expect(
        client().create({ packageId: "pkg-1", text: "q", version: "1", ref: "main" }),
      ).rejects.toSatisfy(expectReason("BAD_REQUEST"));
    });

    it("maps the cheap refusals the engine still makes up front", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
      engine.openConversation.mockRejectedValue(new RunEngineError("BUSY", "full"));
      await expect(client().create({ packageId: "pkg-1", text: "q" })).rejects.toSatisfy(
        (error: ORPCError<string, { reason: string }>) => {
          expect(error.code).toBe("TOO_MANY_REQUESTS");
          expect(error.data).toEqual({ reason: "BUSY" });
          return true;
        },
      );
    });
  });

  describe("retry", () => {
    it("retries an own conversation, optionally on another target", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      engine.retryConversation.mockResolvedValue({ conversationId: "c-1", runId: "run-2" });
      await expect(client().retry({ id: "c-1" })).resolves.toEqual({
        conversationId: "c-1",
        runId: "run-2",
      });
      expect(engine.retryConversation).toHaveBeenLastCalledWith({
        ownerId: "user-a",
        conversationId: "c-1",
      });
      await client().retry({ id: "c-1", ref: "v1.0.1" });
      expect(engine.retryConversation).toHaveBeenLastCalledWith({
        ownerId: "user-a",
        conversationId: "c-1",
        ref: "v1.0.1",
      });
    });

    it("is NOT_FOUND for another user's conversation and never retries", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      await expect(client(sessionContext({ id: "user-b" })).retry({ id: "c-1" })).rejects.toSatisfy(
        expectReason("NOT_FOUND"),
      );
      expect(engine.retryConversation).not.toHaveBeenCalled();
    });

    it("maps a refusal to CONFLICT / NOT_RETRYABLE and refuses two targets", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      engine.retryConversation.mockRejectedValue(new RunEngineError("NOT_RETRYABLE", "no"));
      await expect(client().retry({ id: "c-1" })).rejects.toSatisfy(
        (error: ORPCError<string, { reason: string }>) => {
          expect(error.code).toBe("CONFLICT");
          expect(error.data).toEqual({ reason: "NOT_RETRYABLE" });
          return true;
        },
      );
      await expect(client().retry({ id: "c-1", version: "1", ref: "main" })).rejects.toSatisfy(
        expectReason("BAD_REQUEST"),
      );
    });
  });

  describe("send, steer and stop", () => {
    it("pass the caller's id to the engine for an own conversation", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      engine.sendMessage.mockResolvedValue({ conversationId: "c-1", runId: "run-2" });
      engine.steer.mockResolvedValue({ runId: "run-1", seq: 4 });
      engine.stop.mockResolvedValue(true);
      await client().send({ id: "c-1", text: "and then?" });
      await client().steer({ id: "c-1", text: "look at adapters.py" });
      await expect(client().stop({ id: "c-1" })).resolves.toEqual({ stopped: true });
      expect(engine.sendMessage).toHaveBeenCalledWith({
        ownerId: "user-a",
        conversationId: "c-1",
        text: "and then?",
      });
      expect(engine.steer).toHaveBeenCalledWith({
        ownerId: "user-a",
        conversationId: "c-1",
        text: "look at adapters.py",
      });
      expect(engine.stop).toHaveBeenCalledWith({ ownerId: "user-a", conversationId: "c-1" });
    });

    it("are NOT_FOUND for another user's conversation", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      const other = client(sessionContext({ id: "user-b" }));
      await expect(other.send({ id: "c-1", text: "x" })).rejects.toSatisfy(
        expectReason("NOT_FOUND"),
      );
      await expect(other.steer({ id: "c-1", text: "x" })).rejects.toSatisfy(
        expectReason("NOT_FOUND"),
      );
      await expect(other.stop({ id: "c-1" })).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(engine.sendMessage).not.toHaveBeenCalled();
      expect(engine.steer).not.toHaveBeenCalled();
      expect(engine.stop).not.toHaveBeenCalled();
    });

    it("map a finished run to CONFLICT / RUN_FINISHED", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      engine.steer.mockRejectedValue(new RunEngineError("RUN_FINISHED", "finished"));
      await expect(client().steer({ id: "c-1", text: "x" })).rejects.toSatisfy(
        expectReason("CONFLICT", "RUN_FINISHED"),
      );
    });
  });

  describe("retention", () => {
    it("returns the configured period to any signed-in user", async () => {
      envMock.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 30;
      await expect(client().retention()).resolves.toEqual({ days: 30 });
      envMock.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 0;
      await expect(client().retention()).resolves.toEqual({ days: 0 });
    });

    it("requires a session", async () => {
      await expect(client(anonymousContext).retention()).rejects.toSatisfy(
        expectReason("UNAUTHORIZED"),
      );
    });
  });

  describe("delete", () => {
    it("deletes in one statement that refuses live runs", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      db.conversation.deleteMany.mockResolvedValue({ count: 1 });
      await expect(client().delete({ id: "c-1" })).resolves.toEqual({ ok: true });
      expect(db.conversation.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "c-1",
          ownerId: "user-a",
          AgentRuns: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
        },
      });
    });

    it("is CONFLICT / RUN_ACTIVE while a run is live", async () => {
      db.conversation.findFirst.mockResolvedValue({ id: "c-1" });
      db.conversation.deleteMany.mockResolvedValue({ count: 0 });
      await expect(client().delete({ id: "c-1" })).rejects.toSatisfy(
        expectReason("CONFLICT", "RUN_ACTIVE"),
      );
    });

    it("is NOT_FOUND for another user's conversation", async () => {
      db.conversation.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).delete({ id: "c-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.conversation.deleteMany).not.toHaveBeenCalled();
    });
  });
});
