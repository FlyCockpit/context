import { beforeEach, describe, expect, it, vi } from "vitest";

const sweepExpiredOAuthArtifacts = vi.fn();
// @cockpit-context/jobs' store imports the Prisma client (env-validated at load).
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/api/lib/oauth-retention", () => ({ sweepExpiredOAuthArtifacts }));

const { oauthCleanupHandler, oauthCleanupJob, OAUTH_CLEANUP_SCHEDULE } = await import(
  "./oauth-cleanup.js"
);

describe("oauth.cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("is a single-attempt hourly job", () => {
    expect(oauthCleanupJob).toMatchObject({ type: "oauth.cleanup", maxAttempts: 1 });
    expect(OAUTH_CLEANUP_SCHEDULE.everyMs).toBe(60 * 60 * 1000);
    expect(oauthCleanupJob.payload.safeParse({ reason: "admin" }).success).toBe(false);
  });

  it("runs the sweep", async () => {
    sweepExpiredOAuthArtifacts.mockResolvedValue({
      accessTokens: 2,
      refreshTokens: 1,
      clientAssertions: 0,
      unclaimedClients: 3,
    });
    await oauthCleanupHandler.handler({
      id: "j1",
      type: "oauth.cleanup",
      payload: { reason: "schedule" },
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
    });
    expect(sweepExpiredOAuthArtifacts).toHaveBeenCalledOnce();
  });
});
