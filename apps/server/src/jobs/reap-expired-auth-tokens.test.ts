import { beforeEach, describe, expect, it, vi } from "vitest";

const reapExpiredAuthTokens = vi.fn();
// @cockpit-context/jobs' store imports the Prisma client (env-validated at load).
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/api/lib/auth-token-retention", () => ({ reapExpiredAuthTokens }));

const { reapExpiredAuthTokensHandler, reapExpiredAuthTokensJob } = await import(
  "./reap-expired-auth-tokens.js"
);

describe("auth.reap-expired-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("is a single-attempt job: the next daily slot is the retry", () => {
    expect(reapExpiredAuthTokensJob).toMatchObject({
      type: "auth.reap-expired-tokens",
      maxAttempts: 1,
    });
    expect(reapExpiredAuthTokensJob.payload.safeParse({ reason: "admin" }).success).toBe(false);
  });

  it("runs the bounded sweep", async () => {
    reapExpiredAuthTokens.mockResolvedValue({
      deleted: { sessions: 1, verifications: 0 },
    });
    await reapExpiredAuthTokensHandler.handler({
      id: "j1",
      type: "auth.reap-expired-tokens",
      payload: { reason: "schedule" },
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
    });
    expect(reapExpiredAuthTokens).toHaveBeenCalledOnce();
  });
});
