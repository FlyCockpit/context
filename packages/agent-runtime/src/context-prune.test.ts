import { describe, expect, it } from "vitest";

import { type PruneStats, prunableMessageIndices, pruneAgentMessages } from "./context-prune";
import type { AgentMessage, ResultStore } from "./types";
import { wrapUntrustedContent } from "./untrusted";

const START = "<<<UNTRUSTED_WEB_CONTENT_START>>>";
const END = "<<<UNTRUSTED_WEB_CONTENT_END>>>";

const memoryStore = (): ResultStore & {
  entries: Map<string, { body: string; untrusted: boolean }>;
} => {
  const entries = new Map<string, { body: string; untrusted: boolean }>();
  return {
    entries,
    async put(id, entry) {
      entries.set(id, entry);
    },
    async get() {
      return null;
    },
  };
};

const makeMessages = (): AgentMessage[] => {
  // Structure: user, assistant(tool-call), user(tool-result) x3 old large,
  // one old small, then two recent assistant turns with tool results.
  const large = "L".repeat(3_000);
  const small = "s".repeat(100);
  return [
    { id: "u0", role: "user", parts: [{ type: "text", content: "go" }] },
    {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "c1",
          name: "fetch_page",
          arguments: '{"url":"a"}',
          state: "done",
        },
        {
          type: "tool-call",
          id: "c2",
          name: "fetch_page",
          arguments: '{"url":"b"}',
          state: "done",
        },
        {
          type: "tool-call",
          id: "c3",
          name: "fetch_page",
          arguments: '{"url":"c"}',
          state: "done",
        },
        {
          type: "tool-call",
          id: "c4",
          name: "fetch_page",
          arguments: '{"url":"d"}',
          state: "done",
        },
      ],
    },
    {
      id: "tr1",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c1", content: large, state: "done" }],
    },
    {
      id: "tr2",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c2", content: large, state: "done" }],
    },
    {
      id: "tr3",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c3", content: large, state: "done" }],
    },
    {
      id: "tr4",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c4", content: small, state: "done" }],
    },
    // Recent assistant turn 1
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "c5",
          name: "fetch_page",
          arguments: '{"url":"recent1"}',
          state: "done",
        },
      ],
    },
    {
      id: "tr5",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c5", content: "R".repeat(3_000), state: "done" }],
    },
    // Recent assistant turn 2
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "c6",
          name: "fetch_page",
          arguments: '{"url":"recent2"}',
          state: "done",
        },
      ],
    },
    {
      id: "tr6",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c6", content: "S".repeat(3_000), state: "done" }],
    },
  ];
};

describe("prunableMessageIndices", () => {
  it("protects the last two assistant turns", () => {
    const messages = makeMessages();
    const set = prunableMessageIndices(messages, 2);
    // a1 and a2 are the last two assistants — messages from a1 onward are protected.
    const a1 = messages.findIndex((m) => m.id === "a1");
    expect(set.has(a1)).toBe(false);
    expect(set.has(0)).toBe(true);
  });
});

describe("pruneAgentMessages", () => {
  it("replaces old large bodies under a cold predicate; leaves small and recent", async () => {
    const messages = makeMessages();
    const store = memoryStore();
    const beforeCount = messages.length;
    const stats = await pruneAgentMessages(messages, store, {
      lastDispatchAt: 0,
      cacheTtlMs: 1,
      now: 10_000,
    });
    expect(stats.ran).toBe(true);
    expect(stats.prunedBodies).toBe(3);
    expect(messages).toHaveLength(beforeCount);
    // Old large results carry stored markers.
    for (const id of ["tr1", "tr2", "tr3"]) {
      const msg = messages.find((m) => m.id === id);
      const content = msg?.parts[0] && "content" in msg.parts[0] ? msg.parts[0].content : "";
      expect(String(content)).toContain("[stored result id=");
    }
    // Small old body untouched.
    const small = messages.find((m) => m.id === "tr4");
    expect(small?.parts[0] && "content" in small.parts[0] && small.parts[0].content).toBe(
      "s".repeat(100),
    );
    // Recent large bodies untouched.
    const recent = messages.find((m) => m.id === "tr5");
    expect(
      String(recent?.parts[0] && "content" in recent.parts[0] ? recent.parts[0].content : ""),
    ).toBe("R".repeat(3_000));
  });

  it("is a no-op when the cache is warm and under threshold", async () => {
    const messages = makeMessages();
    const store = memoryStore();
    const snapshot = JSON.stringify(messages);
    const stats = await pruneAgentMessages(messages, store, {
      lastDispatchAt: Date.now(),
      cacheTtlMs: 300_000,
      now: Date.now(),
      tokenThreshold: 1_000_000,
    });
    expect(stats.ran).toBe(false);
    expect(stats.reason).toBe("skipped-warm");
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("runs on threshold breach even when the cache is warm", async () => {
    const messages = makeMessages();
    const store = memoryStore();
    const stats = await pruneAgentMessages(messages, store, {
      lastDispatchAt: Date.now(),
      cacheTtlMs: 300_000,
      now: Date.now(),
      tokenThreshold: 10, // very low
    });
    expect(stats.ran).toBe(true);
    expect(stats.reason).toBe("threshold");
    expect(stats.prunedBodies).toBeGreaterThan(0);
  });

  it("elides older identical tool calls", async () => {
    const large = "X".repeat(3_000);
    const messages: AgentMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", content: "go" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "c1",
            name: "fetch_page",
            arguments: '{"url":"same"}',
            state: "done",
          },
          {
            type: "tool-call",
            id: "c2",
            name: "fetch_page",
            arguments: '{"url":"same"}',
            state: "done",
          },
        ],
      },
      {
        id: "r1",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "c1", content: large, state: "done" }],
      },
      {
        id: "r2",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "c2", content: large + "NEW", state: "done" }],
      },
      // Two more assistant turns so r1/r2 are prunable
      { id: "a2", role: "assistant", parts: [{ type: "text", content: "ok" }] },
      { id: "a3", role: "assistant", parts: [{ type: "text", content: "done" }] },
    ];
    const store = memoryStore();
    const stats = await pruneAgentMessages(messages, store, {
      lastDispatchAt: 0,
      cacheTtlMs: 1,
      now: 10_000,
    });
    expect(stats.elidedDuplicates).toBe(1);
    const older = messages.find((m) => m.id === "r1");
    expect(older?.parts[0] && "content" in older.parts[0] && older.parts[0].content).toBe(
      "[duplicate of a later identical call — elided]",
    );
  });

  it("leaves bodies untouched when the store put fails", async () => {
    const messages = makeMessages();
    const failing: ResultStore = {
      async put() {
        throw new Error("redis down");
      },
      async get() {
        return null;
      },
    };
    const snapshot = JSON.stringify(messages.find((m) => m.id === "tr1"));
    const stats: PruneStats = await pruneAgentMessages(messages, failing, {
      lastDispatchAt: 0,
      cacheTtlMs: 1,
      now: 10_000,
    });
    expect(stats.skippedStoreFailures).toBeGreaterThan(0);
    expect(stats.prunedBodies).toBe(0);
    expect(JSON.stringify(messages.find((m) => m.id === "tr1"))).toBe(snapshot);
  });

  it("keeps untrusted markers balanced around pruned heads", async () => {
    const inner = "U".repeat(3_000);
    const wrapped = wrapUntrustedContent(inner, { sourceUrl: "https://example.com" });
    const messages: AgentMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", content: "go" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "c1",
            name: "fetch_page",
            arguments: "{}",
            state: "done",
          },
        ],
      },
      {
        id: "r1",
        role: "user",
        parts: [{ type: "tool-result", toolCallId: "c1", content: wrapped, state: "done" }],
      },
      { id: "a2", role: "assistant", parts: [{ type: "text", content: "x" }] },
      { id: "a3", role: "assistant", parts: [{ type: "text", content: "y" }] },
    ];
    const store = memoryStore();
    await pruneAgentMessages(messages, store, {
      lastDispatchAt: 0,
      cacheTtlMs: 1,
      now: 10_000,
    });
    const content = messages[2]?.parts[0];
    const text = content && "content" in content ? String(content.content) : "";
    expect(text).toContain(START);
    expect(text).toContain(END);
    expect(text.indexOf(START)).toBeLessThan(text.indexOf(END));
    expect(text).toContain("[stored result id=");
  });
  // A trusted and an untrusted result whose bodies are byte-identical must not
  // land on the same stored id. They used to: the id was a hash of the body
  // alone, so the second `put` overwrote the first record wholesale — and since
  // the record carries the `untrusted` flag that re-wraps every retrieved slice
  // in the injection fence, whichever result was stored last decided the trust
  // level for BOTH. Trusted-last silently disarmed the fence for
  // attacker-authored content.
  it("stores identical trusted and untrusted bodies under distinct ids", async () => {
    const body = "L".repeat(3_000);
    const messages: AgentMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", content: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "c1",
            name: "fetch_page",
            arguments: '{"url":"a"}',
            state: "done",
          },
          {
            type: "tool-call",
            id: "c2",
            name: "read_file",
            arguments: '{"path":"b"}',
            state: "done",
          },
        ],
      },
      {
        id: "r1",
        role: "user",
        // Untrusted: fenced, so `stripUntrusted` recovers exactly `body` as the inner.
        parts: [
          {
            type: "tool-result",
            toolCallId: "c1",
            content: wrapUntrustedContent(body, { sourceUrl: "https://evil.test" }),
            state: "done",
          },
        ],
      },
      {
        id: "r2",
        role: "user",
        // Trusted: the same bytes, unfenced.
        parts: [{ type: "tool-result", toolCallId: "c2", content: body, state: "done" }],
      },
      { id: "a2", role: "assistant", parts: [{ type: "text", content: "ok" }] },
      { id: "a3", role: "assistant", parts: [{ type: "text", content: "done" }] },
    ];

    const store = memoryStore();
    await pruneAgentMessages(messages, store, { lastDispatchAt: 0, cacheTtlMs: 1, now: 10_000 });

    // Two entries, not one — and the untrusted one still says so.
    expect(store.entries.size).toBe(2);
    const flags = [...store.entries.values()].map((entry) => entry.untrusted).sort();
    expect(flags).toEqual([false, true]);
    // Both stored bodies are the same content — `trim()` because unwrapping the
    // fence leaves the trailing newline the wrapper joined on. That sameness is
    // the whole point: identical bytes, and still two entries.
    for (const entry of store.entries.values()) expect(entry.body.trim()).toBe(body);
  });
});
