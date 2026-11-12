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
  sendMessage: vi.fn(),
  steer: vi.fn(),
  stop: vi.fn(),
};
vi.mock("@cockpit-context/runs", () => ({
  getRunEngine: () => engine,
  partsFromJson: (value: unknown) => (Array.isArray(value) ? value : []),
}));

const { default: prisma } = await import("@cockpit-context/db");
const { RunEngineError } = await import("@cockpit-context/runs/errors");
const { RepoError } = await import("@cockpit-context/repos/errors");
const { conversationsRouter } = await import("./conversations");

const db = prisma as unknown as {
  conversation: { findMany: MockInstance; findFirst: MockInstance; deleteMany: MockInstance };
  agentRun: { findMany: MockInstance; groupBy: MockInstance };
  runTurn: { findMany: MockInstance };
  package: { findFirst: MockInstance };
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
        { conversationId: "c-live", _sum: { costUsdMicros: 4200 } },
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
  });

  describe("get", () => {
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
      expect((await pending).value).toEqual(relayed);

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
      });
      expect(relayed).not.toHaveProperty("error");

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

  describe("create", () => {
    it("starts a web conversation on an own package", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
      engine.startConversation.mockResolvedValue({
        conversationId: "c-new",
        runId: "run-new",
        commitSha: "d".repeat(40),
        resolvedFrom: "tag:v1",
      });
      await expect(
        client().create({ packageId: "pkg-1", text: "How do sessions work?", version: "1.0.0" }),
      ).resolves.toMatchObject({ conversationId: "c-new" });
      expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual(ownedBy("pkg-1", "user-a"));
      expect(engine.startConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: "user-a",
          packageId: "pkg-1",
          text: "How do sessions work?",
          version: "1.0.0",
          ref: null,
          origin: "web",
        }),
      );
    });

    it("is NOT_FOUND for another user's package and never starts a run", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).create({ packageId: "pkg-1", text: "q" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(engine.startConversation).not.toHaveBeenCalled();
    });

    it("refuses a version and a ref together", async () => {
      await expect(
        client().create({ packageId: "pkg-1", text: "q", version: "1", ref: "main" }),
      ).rejects.toSatisfy(expectReason("BAD_REQUEST"));
    });

    it("maps an unresolvable version to its reason with the nearest tags", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
      engine.startConversation.mockRejectedValue(
        new RepoError("VERSION_NOT_FOUND", "no tag", { nearestTags: ["v1.0.1", "v0.9.0"] }),
      );
      await expect(
        client().create({ packageId: "pkg-1", text: "q", version: "1.0.0" }),
      ).rejects.toSatisfy((error: ORPCError<string, { reason: string; nearestTags: string[] }>) => {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.data).toEqual({
          reason: "VERSION_NOT_FOUND",
          nearestTags: ["v1.0.1", "v0.9.0"],
        });
        return true;
      });
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
