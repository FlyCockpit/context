import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED: true,
  COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS: 3600,
  COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES: 500,
}));
vi.mock("@cockpit-context/env/server", () => ({ env: mockEnv }));
const repoListeners = vi.hoisted(() => [] as Array<(id: string, reason: string) => void>);
vi.mock("@cockpit-context/repos", () => ({
  onRepositoryChange: (listener: (id: string, reason: string) => void) => {
    repoListeners.push(listener);
    return () => {};
  },
}));

const {
  answerModelIdentity,
  answerReuseKey,
  configureAnswerReuse,
  createAnswerReuse,
  invalidateAnswersForPackage,
  normalizeQuestion,
  requestedTarget,
} = await import("./answer-reuse");

import type { StartedConversation } from "./engine";

const SHA = "a".repeat(40);

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((r) => setImmediate(r));
};

const keyInput = {
  ownerId: "user-a",
  packageId: "pkg1",
  repositoryId: "repo1",
  requested: "version:1.0.0",
  commitSha: SHA,
  notes: "We pin v1.",
  subdirectory: null,
  overview: null,
  question: "How do I pad?",
  modelIdentity: answerModelIdentity({
    model: "vendor/main",
    helperModel: "vendor/helper",
    modelApi: "responses",
    baseUrl: undefined,
    maxIterations: 100,
    runTimeoutMs: 600_000,
  }),
};
const scope = { ownerId: "user-a", packageId: "pkg1", repositoryId: "repo1", commitSha: SHA };

/** A reuse layer whose runs finish when `finish(runId)` is called. */
function harness(
  overrides: {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
    runSha?: string;
    stillValid?: (runId: string) => Promise<boolean>;
  } = {},
) {
  let clock = 0;
  let next = 0;
  const finishes = new Map<string, ReturnType<typeof deferred<boolean>>>();
  const valid = new Set<string>();
  const start = vi.fn(async (): Promise<StartedConversation> => {
    next += 1;
    const runId = `run-${next}`;
    finishes.set(runId, deferred<boolean>());
    return {
      runId,
      conversationId: `conv-${next}`,
      commitSha: overrides.runSha ?? SHA,
      resolvedFrom: "tag:v1",
    };
  });
  const reuse = createAnswerReuse({
    enabled: () => overrides.enabled ?? true,
    ttlMs: () => overrides.ttlMs ?? 60_000,
    maxEntries: () => overrides.maxEntries ?? 10,
    now: () => clock,
    settle: (_ownerId, runId) => finishes.get(runId)?.promise ?? Promise.resolve(false),
    stillValid: async (_ownerId, runId) =>
      overrides.stillValid ? overrides.stillValid(runId) : valid.has(runId),
  });
  return {
    reuse,
    start,
    advance: (ms: number) => (clock += ms),
    async finish(runId: string, reusable = true) {
      if (reusable) valid.add(runId);
      finishes.get(runId)?.resolve(reusable);
      await settle();
    },
    forget: (runId: string) => valid.delete(runId),
  };
}

describe("answerReuseKey", () => {
  it("normalizes whitespace but keeps case", () => {
    expect(normalizeQuestion("  How   do\nI\tpad? ")).toBe("How do I pad?");
    expect(answerReuseKey({ ...keyInput, question: " How do  I pad?\n" })).toBe(
      answerReuseKey(keyInput),
    );
    expect(answerReuseKey({ ...keyInput, question: "how do I pad?" })).not.toBe(
      answerReuseKey(keyInput),
    );
  });

  it.each([
    ["owner", { ownerId: "user-b" }],
    ["package", { packageId: "pkg2" }],
    ["repository", { repositoryId: "repo2" }],
    ["commit", { commitSha: "b".repeat(40) }],
    ["requested version or ref", { requested: "ref:main" }],
    ["notes", { notes: "We pin v2." }],
    ["subdirectory", { subdirectory: "packages/x" }],
    ["overview (override or regenerated summary)", { overview: "Mine." }],
    ["model", { modelIdentity: "other" }],
  ])("changes with the %s", (_name, change) => {
    expect(answerReuseKey({ ...keyInput, ...change })).not.toBe(answerReuseKey(keyInput));
  });
});

describe("requestedTarget", () => {
  it("names what was asked for", () => {
    expect(requestedTarget("1.0.0", null)).toBe("version:1.0.0");
    expect(requestedTarget(null, "main")).toBe("ref:main");
    expect(requestedTarget(null, null)).toBe("default");
  });
});

describe("createAnswerReuse", () => {
  const key = answerReuseKey(keyInput);

  it("never stores or shares a run that landed on another commit than the key's", async () => {
    const h = harness({ runSha: "c".repeat(40) });
    const first = await h.reuse.acquire(key, scope, h.start);
    expect(first.reuse).toBeNull();
    expect(first.started.commitSha).toBe("c".repeat(40));
    // Not joinable while running…
    expect(h.reuse.size).toBe(0);
    const second = await h.reuse.acquire(key, scope, h.start);
    expect(second.reuse).toBeNull();
    // …and never cached once it completes.
    await h.finish(first.started.runId);
    await h.finish(second.started.runId);
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(3);
  });

  it("does not serve an answer invalidated while its validity was being checked", async () => {
    const gate = deferred<boolean>();
    let blockNext = false;
    const h = harness({ stillValid: () => (blockNext ? gate.promise : Promise.resolve(true)) });
    const first = await h.reuse.acquire(key, scope, h.start);
    await h.finish(first.started.runId);
    blockNext = true;
    const pendingHit = h.reuse.acquire(key, scope, h.start);
    await settle();
    h.reuse.invalidatePackage("pkg1");
    blockNext = false;
    gate.resolve(true);
    const result = await pendingHit;
    expect(result.reuse).toBeNull();
    expect(result.started.runId).not.toBe(first.started.runId);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("coalesces two concurrent identical questions into one investigation", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.reuse.acquire(key, scope, h.start),
      h.reuse.acquire(key, scope, h.start),
    ]);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(first.reuse).toBeNull();
    expect(second.reuse).toBe("in-flight");
    expect(second.started.runId).toBe(first.started.runId);
  });

  it("never shares across owners", async () => {
    const h = harness();
    const otherKey = answerReuseKey({ ...keyInput, ownerId: "user-b" });
    const [a, b] = await Promise.all([
      h.reuse.acquire(key, scope, h.start),
      h.reuse.acquire(otherKey, { ...scope, ownerId: "user-b" }, h.start),
    ]);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(a.started.runId).not.toBe(b.started.runId);
    // Even a forged identical key cannot hand one owner another owner's run.
    await h.finish(a.started.runId);
    const forged = await h.reuse.acquire(key, { ...scope, ownerId: "user-b" }, h.start);
    expect(forged.reuse).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(3);
  });

  it("answers from the cache after completion, until the TTL runs out", async () => {
    const h = harness({ ttlMs: 60_000 });
    const first = await h.reuse.acquire(key, scope, h.start);
    await h.finish(first.started.runId);
    const hit = await h.reuse.acquire(key, scope, h.start);
    expect(hit.reuse).toBe("cache");
    expect(hit.started.runId).toBe(first.started.runId);
    h.advance(60_001);
    const miss = await h.reuse.acquire(key, scope, h.start);
    expect(miss.reuse).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed, stopped or steered run", async () => {
    const h = harness();
    const first = await h.reuse.acquire(key, scope, h.start);
    await h.finish(first.started.runId, false);
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("drops a cached run that no longer exists (conversation deleted)", async () => {
    const h = harness();
    const first = await h.reuse.acquire(key, scope, h.start);
    await h.finish(first.started.runId);
    h.forget(first.started.runId);
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
  });

  it("misses after a notes change (a different key)", async () => {
    const h = harness();
    const first = await h.reuse.acquire(key, scope, h.start);
    await h.finish(first.started.runId);
    const changed = answerReuseKey({ ...keyInput, notes: "We pin v2 now." });
    expect((await h.reuse.acquire(changed, scope, h.start)).reuse).toBeNull();
  });

  it("invalidates by package, repository (optionally per owner) and owner", async () => {
    const h = harness();
    const cached = async () => {
      h.reuse.clear();
      const run = await h.reuse.acquire(key, scope, h.start);
      await h.finish(run.started.runId);
    };
    await cached();
    h.reuse.invalidatePackage("pkg1");
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
    await cached();
    h.reuse.invalidateRepository("repo1", "user-b");
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBe("cache");
    h.reuse.invalidateRepository("repo1");
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
    await cached();
    h.reuse.invalidateOwner("user-a");
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
  });

  it("never stores a run that was invalidated while it ran", async () => {
    const h = harness();
    const first = await h.reuse.acquire(key, scope, h.start);
    h.reuse.invalidatePackage("pkg1");
    await h.finish(first.started.runId);
    expect((await h.reuse.acquire(key, scope, h.start)).reuse).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const h = harness({ enabled: false });
    await Promise.all([h.reuse.acquire(key, scope, h.start), h.reuse.acquire(key, scope, h.start)]);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.reuse.size).toBe(0);
  });

  it("is bounded", async () => {
    const h = harness({ maxEntries: 2 });
    for (const question of ["a", "b", "c"]) {
      const run = await h.reuse.acquire(answerReuseKey({ ...keyInput, question }), scope, h.start);
      await h.finish(run.started.runId);
    }
    expect(h.reuse.size).toBe(2);
    const oldest = answerReuseKey({ ...keyInput, question: "a" });
    expect((await h.reuse.acquire(oldest, scope, h.start)).reuse).toBeNull();
  });

  it("hands followers the leader's start error", async () => {
    const h = harness();
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("no tag"), { code: "VERSION_NOT_FOUND" });
    });
    const results = await Promise.allSettled([
      h.reuse.acquire(key, scope, failing),
      h.reuse.acquire(key, scope, failing),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(h.reuse.size).toBe(0);
  });

  it("lets a follower retry once as the leader when the leader's request was aborted", async () => {
    const h = harness();
    const leader = new AbortController();
    const gate = deferred();
    let calls = 0;
    const start = vi.fn(async (): Promise<StartedConversation> => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        throw new Error("aborted");
      }
      return h.start();
    });
    const first = h.reuse.acquire(key, scope, start, leader.signal);
    const second = h.reuse.acquire(key, scope, start);
    await settle();
    leader.abort();
    gate.resolve();
    await expect(first).rejects.toThrow("aborted");
    await expect(second).resolves.toMatchObject({ reuse: null });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a follower that gives up does not affect the leader's run", async () => {
    const h = harness();
    const gate = deferred();
    const start = vi.fn(async () => {
      await gate.promise;
      return h.start();
    });
    const follower = new AbortController();
    const first = h.reuse.acquire(key, scope, start);
    const second = h.reuse.acquire(key, scope, start, follower.signal);
    await settle();
    follower.abort();
    await expect(second).rejects.toBeDefined();
    gate.resolve();
    const leader = await first;
    expect(leader.reuse).toBeNull();
    // A third asker still joins the leader's run.
    expect((await h.reuse.acquire(key, scope, start)).reuse).toBe("in-flight");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("configureAnswerReuse", () => {
  it("drops a repository's answers on a re-fetch notification and serves package invalidation", async () => {
    let next = 0;
    const reuse = configureAnswerReuse({
      settle: async () => true,
      stillValid: async () => true,
    });
    const start = vi.fn(
      async (): Promise<StartedConversation> => ({
        runId: `run-${++next}`,
        conversationId: "c",
        commitSha: SHA,
        resolvedFrom: "tag:v1",
      }),
    );
    const key = answerReuseKey(keyInput);
    await reuse.acquire(key, scope, start);
    await settle();
    expect((await reuse.acquire(key, scope, start)).reuse).toBe("cache");
    // A routine fetch keeps answers (the key holds the commit)…
    for (const listener of repoListeners) listener("repo1", "fetched");
    expect((await reuse.acquire(key, scope, start)).reuse).toBe("cache");
    // …an explicit re-fetch drops them.
    for (const listener of repoListeners) listener("repo1", "refetched");
    expect((await reuse.acquire(key, scope, start)).reuse).toBeNull();
    await settle();
    invalidateAnswersForPackage("pkg1");
    expect((await reuse.acquire(key, scope, start)).reuse).toBeNull();
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("is turned off by COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED=false", async () => {
    mockEnv.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED = false;
    try {
      const reuse = configureAnswerReuse({
        settle: async () => true,
        stillValid: async () => true,
      });
      const start = vi.fn(
        async (): Promise<StartedConversation> => ({
          runId: "r",
          conversationId: "c",
          commitSha: SHA,
          resolvedFrom: "tag:v1",
        }),
      );
      const key = answerReuseKey(keyInput);
      await Promise.all([reuse.acquire(key, scope, start), reuse.acquire(key, scope, start)]);
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      mockEnv.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED = true;
    }
  });
});
