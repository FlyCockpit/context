import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: { COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90 },
  sweepExpiredConversations: vi.fn(),
}));

// @cockpit-context/jobs' store imports the Prisma client (env-validated at load).
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/env/server", () => ({ env: state.env }));
vi.mock("@cockpit-context/api/lib/conversation-retention", () => ({
  sweepExpiredConversations: state.sweepExpiredConversations,
}));

const { conversationRetentionEnabled, conversationRetentionHandler, conversationRetentionJob } =
  await import("./conversation-retention.js");

function run() {
  return conversationRetentionHandler.handler({
    id: "j1",
    type: "conversations.retention",
    payload: { reason: "schedule" },
    attempt: 1,
    maxAttempts: 1,
    signal: new AbortController().signal,
  });
}

describe("conversations.retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 90;
  });

  it("is a single-attempt job with a schedule-only payload", () => {
    expect(conversationRetentionJob).toMatchObject({
      type: "conversations.retention",
      maxAttempts: 1,
    });
    expect(conversationRetentionJob.payload.safeParse({ reason: "admin" }).success).toBe(false);
  });

  it("is enabled for any positive number of days and off at 0", () => {
    expect(conversationRetentionEnabled()).toBe(true);
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 0;
    expect(conversationRetentionEnabled()).toBe(false);
  });

  it("sweeps with the configured days and logs counts only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 30;
    state.sweepExpiredConversations.mockResolvedValue({
      enabled: true,
      deleted: 7,
      batches: 1,
      capped: false,
    });
    await run();
    expect(state.sweepExpiredConversations).toHaveBeenCalledWith(30);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toMatch(/deleted 7 conversation\(s\) inactive for 30\+ day\(s\)/);
  });

  it("says when the batch cap left work for the next run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    state.sweepExpiredConversations.mockResolvedValue({
      enabled: true,
      deleted: 5000,
      batches: 50,
      capped: true,
    });
    await run();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/batch cap reached/);
  });

  it("is a no-op when retention is 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 0;
    state.sweepExpiredConversations.mockResolvedValue({
      enabled: false,
      deleted: 0,
      batches: 0,
      capped: false,
    });
    await run();
    expect(String(log.mock.calls[0]?.[0])).toMatch(/retention is off/);
  });
});
