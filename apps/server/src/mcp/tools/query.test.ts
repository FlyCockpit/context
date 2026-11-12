import { RepoError } from "@cockpit-context/repos/errors";
import type { RunSnapshot } from "@cockpit-context/runs";
import { RunEngineError } from "@cockpit-context/runs/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpIdentity } from "../credentials";
import type { McpToolContext } from "./types";

vi.mock("@cockpit-context/env/server", () => ({
  env: { COCKPIT_CONTEXT_MCP_WAIT_SECONDS: 900, COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER: 10 },
}));

/** The `COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER` default. */
const MAX_RESULT_WAITS_PER_USER = 10;
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: vi.fn() }));

const {
  progressText,
  queryResult,
  repoErrorToToolError,
  runGetQueryResult,
  runQueryDependency,
  settleRun,
} = await import("./query");
const { McpToolError } = await import("./types");
const { createKeyedSlots } = await import("../admission");
const { answerReuseKey, createAnswerReuse } = await import("@cockpit-context/runs/answer-reuse");

type QueryDeps = NonNullable<Parameters<typeof runQueryDependency>[2]>;

const identity: McpIdentity = {
  userId: "user-a",
  credential: { kind: "agent_token", tokenId: "tok-1" },
  label: "Claude Code",
  allowPropose: true,
  autoApprove: false,
};

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    conversationId: "conv-1",
    kind: "main",
    status: "running",
    phase: "running",
    answer: null,
    stopReason: null,
    error: null,
    iterations: 4,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsdMicros: 0 },
    ...overrides,
  };
}

/** A run engine that finishes the run after `finishAfterMs` of real time. */
function fakeEngine({ finishAfterMs }: { finishAfterMs: number }) {
  const startedAt = Date.now();
  const finished = () => Date.now() - startedAt >= finishAfterMs;
  return {
    assertCanStart: vi.fn((_ownerId: string) => {}),
    startConversation: vi.fn(async () => ({
      conversationId: "conv-1",
      runId: "run-1",
      commitSha: "a".repeat(40),
      resolvedFrom: "tag:v5.0.0",
    })),
    waitForRun: vi.fn(
      async (input: {
        ownerId: string;
        runId: string;
        timeoutMs: number;
        signal?: AbortSignal;
      }) => {
        if (input.ownerId !== "user-a" || input.runId !== "run-1") {
          throw new RunEngineError("RUN_NOT_FOUND", "Run not found.");
        }
        const remaining = finishAfterMs - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(input.timeoutMs, remaining)));
        }
        return finished()
          ? snapshot({ status: "completed", phase: null, answer: "Use escapeStringRegexp()." })
          : snapshot();
      },
    ),
    liveState: vi.fn(() => ({
      runs: [
        {
          runId: "run-1",
          parentRunId: null,
          kind: "main" as const,
          phase: "running" as const,
          iterations: 12,
          usage: snapshot().usage,
          partial: null,
        },
      ],
    })),
  };
}

function deps(
  engine: ReturnType<typeof fakeEngine>,
  maxWaitSeconds = 0.2,
  resultWaits = createKeyedSlots(MAX_RESULT_WAITS_PER_USER),
): QueryDeps {
  return {
    engine: () => engine,
    maxWaitSeconds: () => maxWaitSeconds,
    progressIntervalMs: 30,
    versionOf: async () => ({ sha: "a".repeat(40), from: "tag:v5.0.0" }),
    findPackage: async () => ({ id: "pkg-1", identifier: "npm:escape-string-regexp" }),
    resultWaits,
    credentialLive: async () => true,
    // Reuse off unless a test turns it on (see "answer reuse" below).
    reuseKey: async () => null,
    answerReuse: () => {
      throw new Error("answer reuse is off in this test");
    },
  };
}

function context(signal = new AbortController().signal) {
  const progress = vi.fn(async (_message: string) => {});
  const ctx: McpToolContext = { identity, signal, requestId: "r", progress };
  return { ctx, progress };
}

const INPUT = {
  identifier: "npm:escape-string-regexp",
  question: "How do I escape a string?",
  version: "5.0.0",
};

it("cuts off a held wait when the credential is revoked between ticks", async () => {
  const engine = fakeEngine({ finishAfterMs: 10_000 });
  const dependencies = {
    ...deps(engine),
    credentialLive: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
  };
  await expect(
    runQueryDependency(
      { identifier: "npm:escape-string-regexp", question: "How?" },
      context().ctx,
      dependencies,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(dependencies.credentialLive).toHaveBeenCalledTimes(2);
});

it.each([new Date("2026-11-01T00:00:00Z"), null])(
  "surfaces stale resolution metadata with fetchedAt=%s and labels completed answers",
  async (fetchedAt) => {
    const base = fakeEngine({ finishAfterMs: 0 });
    const engine = {
      ...base,
      startConversation: vi.fn(async () => ({
        conversationId: "conv-1",
        runId: "run-1",
        commitSha: "a".repeat(40),
        resolvedFrom: "branch:main",
        stale: true,
        fetchedAt,
      })),
    };
    const result = await runQueryDependency(INPUT, context().ctx, deps(engine));
    expect(result).toMatchObject({
      content_trust: "untrusted_dependency_derived",
      version_resolved: {
        stale: true,
        fetched_at: fetchedAt?.toISOString() ?? null,
      },
    });
  },
);

describe("query_dependency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a main MCP run as the credential's user and returns the answer when it finishes in time", async () => {
    const engine = fakeEngine({ finishAfterMs: 50 });
    const { ctx } = context();
    const result = await runQueryDependency(INPUT, ctx, deps(engine));
    expect(engine.startConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-a",
        packageId: "pkg-1",
        version: "5.0.0",
        ref: null,
        origin: "mcp",
        mcp: { agentTokenId: "tok-1", grantId: null, label: "Claude Code" },
      }),
    );
    expect(result).toEqual({
      query_id: "run-1",
      version_resolved: { sha: "a".repeat(40), from: "tag:v5.0.0" },
      status: "completed",
      content_trust: "untrusted_dependency_derived",
      answer: "Use escapeStringRegexp().",
    });
  });

  it("returns running with the query_id when the wait runs out, then get_query_result waits for it", async () => {
    const engine = fakeEngine({ finishAfterMs: 400 });
    const { ctx } = context();
    const started = Date.now();
    const first = await runQueryDependency({ ...INPUT, wait_seconds: 0.1 }, ctx, deps(engine, 5));
    expect(Date.now() - started).toBeLessThan(350);
    expect(first).toMatchObject({ query_id: "run-1", status: "running" });
    expect(first).not.toHaveProperty("answer");
    const second = await runGetQueryResult(
      { query_id: "run-1", wait_seconds: 2 },
      ctx,
      deps(engine, 5),
    );
    expect(second).toMatchObject({ status: "completed", answer: "Use escapeStringRegexp()." });
  });

  it("never waits longer than the server maximum, whatever wait_seconds asks", async () => {
    const engine = fakeEngine({ finishAfterMs: 10_000 });
    const { ctx } = context();
    const started = Date.now();
    const result = await runQueryDependency(
      { ...INPUT, wait_seconds: 3600 },
      ctx,
      deps(engine, 0.15),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ status: "running" });
  });

  it("sends progress while resolving and while investigating", async () => {
    const engine = fakeEngine({ finishAfterMs: 150 });
    const { ctx, progress } = context();
    await runQueryDependency(INPUT, ctx, deps(engine, 1));
    const messages = progress.mock.calls.map((call) => call[0]);
    expect(messages[0]).toContain("resolving version 5.0.0 of npm:escape-string-regexp");
    expect(messages).toContain("investigating: 12 steps");
  });

  it("answers running at once when the request is aborted mid-wait", async () => {
    const engine = fakeEngine({ finishAfterMs: 10_000 });
    const controller = new AbortController();
    const { ctx } = context(controller.signal);
    setTimeout(() => controller.abort(), 40);
    const result = await runQueryDependency(INPUT, ctx, deps(engine, 30));
    expect(result).toMatchObject({ status: "running" });
  });

  it("explains an unknown version with nearby tags", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    engine.startConversation.mockRejectedValueOnce(
      new RepoError("VERSION_NOT_FOUND", "git said: no tag", { nearestTags: ["v5.0.0", "v4.0.0"] }),
    );
    const { ctx } = context();
    const error = await runQueryDependency(INPUT, ctx, deps(engine)).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(McpToolError);
    expect(error.code).toBe("VERSION_NOT_FOUND");
    expect(error.message).toContain("v5.0.0, v4.0.0");
    expect(error.details).toEqual({ nearest_tags: ["v5.0.0", "v4.0.0"] });
  });

  it("maps a missing model to a refusal the agent can relay", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    engine.startConversation.mockRejectedValueOnce(
      new RunEngineError("MODEL_NOT_CONFIGURED", "No model."),
    );
    const { ctx } = context();
    await expect(runQueryDependency(INPUT, ctx, deps(engine))).rejects.toMatchObject({
      code: "MODEL_NOT_CONFIGURED",
    });
  });
});

describe("get_query_result", () => {
  it("is owner-scoped: another user's run is QUERY_NOT_FOUND", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    const { ctx } = context();
    const other = { ...ctx, identity: { ...identity, userId: "user-b" } };
    await expect(
      runGetQueryResult({ query_id: "run-1" }, other, deps(engine)),
    ).rejects.toMatchObject({
      code: "QUERY_NOT_FOUND",
    });
  });

  it("refuses helper and summary runs", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    engine.waitForRun.mockResolvedValueOnce(snapshot({ kind: "helper" }));
    const { ctx } = context();
    await expect(runGetQueryResult({ query_id: "run-1" }, ctx, deps(engine))).rejects.toMatchObject(
      {
        code: "QUERY_NOT_FOUND",
      },
    );
  });

  it("holds a per-user wait slot while it waits and gives it back after", async () => {
    const engine = fakeEngine({ finishAfterMs: 400 });
    const slots = createKeyedSlots(MAX_RESULT_WAITS_PER_USER);
    const { ctx } = context();
    const pending = runGetQueryResult({ query_id: "run-1" }, ctx, deps(engine, 2, slots));
    await vi.waitFor(() => expect(slots.held("user-a")).toBe(1), { interval: 5 });
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(slots.held("user-a")).toBe(0);
  });

  it("answers running at once, without waiting, when the user's wait slots are taken", async () => {
    const engine = fakeEngine({ finishAfterMs: 60_000 });
    const slots = createKeyedSlots(MAX_RESULT_WAITS_PER_USER);
    const held = Array.from({ length: MAX_RESULT_WAITS_PER_USER }, () =>
      slots.tryAcquire("user-a"),
    );
    const { ctx } = context();
    const startedAt = Date.now();
    const result = await runGetQueryResult(
      { query_id: "run-1", wait_seconds: 60 },
      ctx,
      deps(engine, 60, slots),
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toMatchObject({
      query_id: "run-1",
      status: "running",
      version_resolved: { sha: "a".repeat(40), from: "tag:v5.0.0" },
    });
    expect(result).toEqual(queryResult(snapshot(), { sha: "a".repeat(40), from: "tag:v5.0.0" }));
    // Only the zero-wait ownership read.
    expect(engine.waitForRun).toHaveBeenCalledOnce();
    expect(engine.waitForRun).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 0 }));

    // The slots are per user.
    expect(slots.tryAcquire("user-b")).not.toBeNull();
    for (const release of held) release?.();
  });

  it("gives the slot back when the wait throws", async () => {
    const engine = fakeEngine({ finishAfterMs: 60_000 });
    engine.waitForRun
      .mockImplementationOnce(async () => snapshot())
      .mockRejectedValueOnce(new Error("engine down"));
    const slots = createKeyedSlots(MAX_RESULT_WAITS_PER_USER);
    const { ctx } = context();
    await expect(
      runGetQueryResult({ query_id: "run-1" }, ctx, deps(engine, 1, slots)),
    ).rejects.toThrow("engine down");
    expect(slots.held("user-a")).toBe(0);
  });

  it("takes no slot for a run that has already ended", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    const slots = createKeyedSlots(MAX_RESULT_WAITS_PER_USER);
    const acquire = vi.spyOn(slots, "tryAcquire");
    const { ctx } = context();
    await expect(
      runGetQueryResult({ query_id: "run-1" }, ctx, deps(engine, 1, slots)),
    ).resolves.toMatchObject({ status: "completed" });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("waiting for a run", () => {
  it("returns an orphaned non-terminal run as running after one re-read, without spinning", async () => {
    const engine = fakeEngine({ finishAfterMs: 60_000 });
    // A row left `running` with no live run behind it: the engine answers at once.
    engine.waitForRun.mockImplementation(async () => snapshot());
    engine.liveState.mockReturnValue({ runs: [] });
    const { ctx } = context();
    const result = await runQueryDependency({ ...INPUT, wait_seconds: 60 }, ctx, deps(engine, 60));
    expect(result).toMatchObject({ query_id: "run-1", status: "running" });
    // The first wait, then exactly one re-read, well before the 60 s deadline.
    expect(engine.waitForRun).toHaveBeenCalledTimes(2);
    expect(engine.waitForRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: "run-1", timeoutMs: 0 }),
    );
  });

  it("returns the re-read when the run finished between the store read and the live check", async () => {
    const engine = fakeEngine({ finishAfterMs: 60_000 });
    engine.waitForRun
      .mockImplementationOnce(async () => snapshot())
      .mockImplementationOnce(async () => snapshot({ status: "completed", answer: "Done." }));
    engine.liveState.mockReturnValue({ runs: [] });
    const { ctx } = context();
    const result = await runQueryDependency({ ...INPUT, wait_seconds: 60 }, ctx, deps(engine, 60));
    expect(result).toMatchObject({ status: "completed", answer: "Done." });
    expect(engine.waitForRun).toHaveBeenCalledTimes(2);
  });
});

describe("queryResult", () => {
  it("returns only the final answer, never the run's error text", () => {
    const failed = queryResult(
      snapshot({
        status: "failed",
        stopReason: "model-error",
        error: "401 from provider sk-or-123",
      }),
      null,
    );
    expect(JSON.stringify(failed)).not.toContain("sk-or-123");
    expect(failed).toMatchObject({ status: "failed", message: expect.stringContaining("model") });
    const stopped = queryResult(snapshot({ status: "stopped", answer: "Partial answer." }), null);
    expect(stopped).toMatchObject({ status: "stopped", answer: "Partial answer." });
  });

  it("says a run interrupted by a restart was cut short by the server, not generic failure", () => {
    const interrupted = queryResult(
      snapshot({ status: "interrupted", stopReason: "interrupted" }),
      null,
    );
    expect(interrupted).toEqual({
      query_id: "run-1",
      status: "interrupted",
      message: expect.stringContaining("server restart"),
    });
    expect(interrupted).not.toMatchObject({
      message: "The investigation did not produce an answer. Try asking again.",
    });
    const aborted = queryResult(snapshot({ status: "stopped", stopReason: "aborted" }), null);
    expect(aborted).toMatchObject({
      message: "The investigation was stopped before it finished.",
    });
  });
});

describe("repoErrorToToolError", () => {
  it("asks for an SSH key or a host confirmation on an auth failure, without git stderr", () => {
    const error = repoErrorToToolError(
      new RepoError("GIT_FAILED", "git@github.com: Permission denied (publickey). fatal: …"),
      "git:me/private",
    );
    expect(error.code).toBe("CLONE_AUTH_FAILED");
    expect(error.message).toContain("SSH key");
    expect(error.message).toContain("confirm the host");
    expect(error.message).not.toContain("Permission denied");
    expect(
      repoErrorToToolError(
        new RepoError("HOST_KEY_UNCONFIRMED", "x", { host: "git.example.com" }),
        "git:a/b",
      ).message,
    ).toContain("confirm the host");
  });
});

describe("progressText", () => {
  it("names the phase and counts steps and helpers", () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    expect(progressText(engine, "user-a", "conv-1")).toBe("investigating: 12 steps");
    engine.liveState.mockReturnValueOnce({ runs: [] });
    expect(progressText(engine, "user-a", "conv-1")).toBeNull();
  });
});

it("tells the agent a snapshot version requires an update in Cockpit Context without internal details", () => {
  const error = repoErrorToToolError(
    new RepoError("PACKAGE_SNAPSHOT_REF_MISSING", "secret detail"),
    "git:owner/private",
  );
  expect(error.code).toBe("PACKAGE_SNAPSHOT_REF_MISSING");
  expect(error.message).toContain("user must update the package in Cockpit Context");
  expect(error.message).not.toContain("secret detail");
});

describe("answer reuse", () => {
  const SHA = "a".repeat(40);

  /** An engine whose runs complete when `finish()` is called; runs are owner-scoped. */
  function reuseEngine() {
    let next = 0;
    const owners = new Map<string, string>();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const view = (runId: string) =>
      finished
        ? snapshot({
            runId,
            conversationId: `conv-${runId}`,
            status: "completed",
            phase: null,
            answer: `answer of ${runId}`,
          })
        : snapshot({ runId, conversationId: `conv-${runId}` });
    const engine = {
      assertCanStart: vi.fn((_ownerId: string) => {}),
      startConversation: vi.fn(async (input: { ownerId: string }) => {
        next += 1;
        const runId = `run-${next}`;
        owners.set(runId, input.ownerId);
        return {
          conversationId: `conv-${runId}`,
          runId,
          commitSha: SHA,
          resolvedFrom: "tag:v5.0.0",
        };
      }),
      waitForRun: vi.fn(async (input: { ownerId: string; runId: string; timeoutMs: number }) => {
        if (owners.get(input.runId) !== input.ownerId) {
          throw new RunEngineError("RUN_NOT_FOUND", "Run not found.");
        }
        if (!finished && input.timeoutMs > 0) {
          await Promise.race([done, new Promise((r) => setTimeout(r, input.timeoutMs))]);
        }
        return view(input.runId);
      }),
      liveState: vi.fn((_ownerId: string, conversationId: string) => ({
        runs: finished
          ? []
          : [
              {
                runId: conversationId.replace("conv-", ""),
                parentRunId: null,
                kind: "main" as const,
                phase: "running" as const,
                iterations: 1,
                usage: snapshot().usage,
                partial: null,
              },
            ],
      })),
    };
    return {
      engine,
      finish() {
        finished = true;
        release();
      },
    };
  }

  function reuseDeps(
    fake: ReturnType<typeof reuseEngine>,
    state = { notes: "We pin v5.", clock: 0 },
  ) {
    const reuse = createAnswerReuse({
      enabled: () => true,
      ttlMs: () => 60_000,
      maxEntries: () => 100,
      now: () => state.clock,
      settle: async (ownerId, runId) => {
        const result = await fake.engine.waitForRun({ ownerId, runId, timeoutMs: 5_000 });
        return result.status === "completed";
      },
      stillValid: async () => true,
    });
    const dependencies: QueryDeps = {
      ...deps(fake.engine as unknown as ReturnType<typeof fakeEngine>, 2),
      reuseKey: async (input) => {
        const scope = {
          ownerId: input.ownerId,
          packageId: input.packageId,
          repositoryId: "repo1",
          commitSha: SHA,
        };
        return {
          key: answerReuseKey({
            ...scope,
            requested: "default",
            notes: state.notes,
            subdirectory: null,
            overview: null,
            question: input.question,
            modelIdentity: "m",
          }),
          scope,
        };
      },
      answerReuse: () => reuse,
    };
    return { dependencies, state, reuse };
  }

  const asToken = (tokenId: string, userId = "user-a") => {
    const { ctx } = context();
    return {
      ...ctx,
      identity: { ...identity, userId, credential: { kind: "agent_token" as const, tokenId } },
    };
  };

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("two agents of one user asking concurrently start exactly one investigation", async () => {
    const fake = reuseEngine();
    const { dependencies } = reuseDeps(fake);
    const asked = [
      runQueryDependency(INPUT, asToken("tok-1"), dependencies),
      runQueryDependency(
        { ...INPUT, question: `  ${INPUT.question}\n` },
        asToken("tok-2"),
        dependencies,
      ),
    ];
    await new Promise((r) => setTimeout(r, 20));
    fake.finish();
    const [first, second] = await Promise.all(asked);
    expect(fake.engine.startConversation).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      query_id: "run-1",
      status: "completed",
      answer: "answer of run-1",
    });
    expect(second).toMatchObject({
      query_id: "run-1",
      status: "completed",
      answer: "answer of run-1",
      reused: "running_query",
    });
  });

  it("different owners asking the same question get two investigations", async () => {
    const fake = reuseEngine();
    const { dependencies } = reuseDeps(fake);
    fake.finish();
    const [a, b] = await Promise.all([
      runQueryDependency(INPUT, asToken("tok-1", "user-a"), dependencies),
      runQueryDependency(INPUT, asToken("tok-9", "user-b"), dependencies),
    ]);
    expect(fake.engine.startConversation).toHaveBeenCalledTimes(2);
    expect(a.query_id).not.toBe(b.query_id);
    expect(b).not.toHaveProperty("reused");
  });

  it("reuses a completed answer, misses after a notes change and after the TTL", async () => {
    const fake = reuseEngine();
    const { dependencies, state } = reuseDeps(fake);
    fake.finish();
    await runQueryDependency(INPUT, asToken("tok-1"), dependencies);
    await new Promise((r) => setTimeout(r, 10));
    const again = await runQueryDependency(INPUT, asToken("tok-2"), dependencies);
    expect(again).toMatchObject({ query_id: "run-1", reused: "answer", answer: "answer of run-1" });
    expect(fake.engine.startConversation).toHaveBeenCalledTimes(1);

    state.notes = "We pin v6 now.";
    const afterNotes = await runQueryDependency(INPUT, asToken("tok-1"), dependencies);
    expect(afterNotes).not.toHaveProperty("reused");
    expect(fake.engine.startConversation).toHaveBeenCalledTimes(2);

    await new Promise((r) => setTimeout(r, 10));
    state.clock += 60_001;
    const afterTtl = await runQueryDependency(INPUT, asToken("tok-1"), dependencies);
    expect(afterTtl).not.toHaveProperty("reused");
    expect(fake.engine.startConversation).toHaveBeenCalledTimes(3);
  });

  it("refuses BUSY (or no model) before resolving the reuse key, which can clone", async () => {
    const fake = reuseEngine();
    const { dependencies } = reuseDeps(fake);
    const reuseKey = vi.fn(dependencies.reuseKey);
    fake.engine.assertCanStart.mockImplementationOnce(() => {
      throw new RunEngineError("BUSY", "busy");
    });
    await expect(
      runQueryDependency(INPUT, asToken("tok-1"), { ...dependencies, reuseKey }),
    ).rejects.toMatchObject({ code: "BUSY" });
    fake.engine.assertCanStart.mockImplementationOnce(() => {
      throw new RunEngineError("MODEL_NOT_CONFIGURED", "no model");
    });
    await expect(
      runQueryDependency(INPUT, asToken("tok-1"), { ...dependencies, reuseKey }),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(reuseKey).not.toHaveBeenCalled();
    expect(fake.engine.startConversation).not.toHaveBeenCalled();
  });

  it("maps the engine's BUSY refusal to a BUSY tool error", async () => {
    const engine = fakeEngine({ finishAfterMs: 0 });
    engine.startConversation.mockRejectedValueOnce(new RunEngineError("BUSY", "busy"));
    await expect(runQueryDependency(INPUT, context().ctx, deps(engine))).rejects.toMatchObject({
      code: "BUSY",
      message: expect.stringMatching(/waiting for an investigation slot/),
    });
  });
});

describe("settleRun", () => {
  it("keeps waiting through rounds while a long-queued run stays live", async () => {
    let clock = 0;
    let calls = 0;
    const engine = {
      waitForRun: vi.fn(async (input: { timeoutMs: number }) => {
        calls += 1;
        // Each round runs out its full timeout; the run completes in round 3.
        clock += input.timeoutMs;
        return calls < 3
          ? snapshot({ status: "queued", phase: "queued" })
          : snapshot({ status: "completed", phase: null, answer: "ok" });
      }),
    };
    const result = await settleRun(engine as never, "user-a", "run-1", 1_000, () => clock);
    expect(result.status).toBe("completed");
    expect(engine.waitForRun).toHaveBeenCalledTimes(3);
  });

  it("gives up when a round returns early unfinished (the run is not live here)", async () => {
    const engine = {
      waitForRun: vi.fn(async () => snapshot({ status: "queued", phase: "queued" })),
    };
    const result = await settleRun(engine as never, "user-a", "run-1", 1_000, () => 0);
    expect(result.status).toBe("queued");
    expect(engine.waitForRun).toHaveBeenCalledTimes(1);
  });
});
