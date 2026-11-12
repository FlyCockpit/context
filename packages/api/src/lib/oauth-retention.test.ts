import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-context/db");
const { OAUTH_CLEANUP_BATCH, sweepExpiredOAuthArtifacts } = await import("./oauth-retention");

type Delegate = { findMany: MockInstance; deleteMany: MockInstance };
const db = prisma as unknown as {
  oauthAccessToken: Delegate;
  oauthRefreshToken: Delegate;
  oauthClientAssertion: Delegate;
  oauthClient: Delegate;
};

const NOW = new Date("2026-10-24T12:00:00Z");
const GRACE_CUTOFF = new Date("2026-10-23T12:00:00Z");

function ids(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
}

describe("sweepExpiredOAuthArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const delegate of [
      db.oauthAccessToken,
      db.oauthRefreshToken,
      db.oauthClientAssertion,
      db.oauthClient,
    ]) {
      delegate.findMany.mockResolvedValue([]);
      delegate.deleteMany.mockResolvedValue({ count: 0 });
    }
  });

  it("deletes only rows past expiry plus the audit grace, re-predicated by id", async () => {
    db.oauthAccessToken.findMany.mockResolvedValueOnce(ids(2, "a"));
    db.oauthAccessToken.deleteMany.mockResolvedValueOnce({ count: 2 });
    const counts = await sweepExpiredOAuthArtifacts(NOW);
    expect(counts.accessTokens).toBe(2);
    expect(db.oauthAccessToken.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: GRACE_CUTOFF } },
      select: { id: true },
      take: OAUTH_CLEANUP_BATCH,
    });
    expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: GRACE_CUTOFF }, id: { in: ["a0", "a1"] } },
    });
  });

  it("keeps a refresh token while any access child is inside the grace", async () => {
    await sweepExpiredOAuthArtifacts(NOW);
    expect(db.oauthRefreshToken.findMany.mock.calls[0]?.[0].where).toEqual({
      expiresAt: { lte: GRACE_CUTOFF },
      oauthAccessTokens: { every: { expiresAt: { lte: GRACE_CUTOFF } } },
    });
  });

  it("removes only ownerless, artifact-free, non-CIMD registrations older than a day", async () => {
    await sweepExpiredOAuthArtifacts(NOW);
    expect(db.oauthClient.findMany.mock.calls[0]?.[0].where).toEqual({
      clientDiscoveryId: null,
      userId: null,
      referenceId: null,
      createdAt: { lte: GRACE_CUTOFF },
      oauthConsents: { none: {} },
      oauthRefreshTokens: { none: {} },
      oauthAccessTokens: { none: {} },
    });
  });

  it("pages until a short page, and stops when a full page deletes nothing", async () => {
    db.oauthAccessToken.findMany
      .mockResolvedValueOnce(ids(OAUTH_CLEANUP_BATCH, "a"))
      .mockResolvedValueOnce(ids(3, "b"));
    db.oauthAccessToken.deleteMany
      .mockResolvedValueOnce({ count: OAUTH_CLEANUP_BATCH })
      .mockResolvedValueOnce({ count: 3 });
    db.oauthClientAssertion.findMany.mockResolvedValue(ids(OAUTH_CLEANUP_BATCH, "c"));
    db.oauthClientAssertion.deleteMany.mockResolvedValue({ count: 0 });
    const counts = await sweepExpiredOAuthArtifacts(NOW);
    expect(counts.accessTokens).toBe(OAUTH_CLEANUP_BATCH + 3);
    expect(db.oauthClientAssertion.findMany).toHaveBeenCalledOnce();
  });
});
