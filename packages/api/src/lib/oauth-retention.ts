import prisma from "@cockpit-context/db";

/**
 * Retention sweep for the Better-Auth OAuth provider's rows behind MCP OAuth
 * (docs/mcp.md), ported from ws-model-proxy's
 * `mcp/oauth-cleanup.ts`. Expiry is only enforced at read time, so without
 * this the token tables would grow forever.
 *
 * One idempotent pass, each delete bounded and predicated on row state only:
 *
 * 1. Access tokens past expiry plus a 24 h audit grace. First, because they
 *    reference refresh tokens (`refreshId`, cascade).
 * 2. Refresh tokens past expiry plus grace whose remaining access children
 *    are all past grace too, so the cascade can only remove rows that were
 *    eligible on their own. Rotated and revoked rows are kept until expiry.
 * 3. Expired client assertions (past grace).
 * 4. Abandoned dynamic registrations: no owner, no consent, no token, not a
 *    CIMD client, registered more than a day ago.
 *
 * Expired authorization codes and DPoP replay reservations live in
 * `verification`, which `auth.reap-expired-tokens` already sweeps. `McpGrant`
 * tombstones are never deleted here: a revoked generation must stay refused.
 */

export const OAUTH_CLEANUP_AUDIT_GRACE_MS = 24 * 60 * 60 * 1000;
export const OAUTH_UNCLAIMED_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const OAUTH_CLEANUP_BATCH = 500;

export interface OAuthCleanupCounts {
  accessTokens: number;
  refreshTokens: number;
  clientAssertions: number;
  unclaimedClients: number;
}

type IdDelegate<Where> = {
  findMany(args: { where: Where; select: { id: true }; take: number }): Promise<{ id: string }[]>;
  deleteMany(args: { where: Where & { id: { in: string[] } } }): Promise<{ count: number }>;
};

/**
 * Read a bounded id page under `where`, delete exactly those ids re-predicated
 * on the same `where`, until a short page. Stops if a full page deleted
 * nothing (a concurrent sweep got there first).
 */
async function deleteBatched<Where extends object>(
  delegate: IdDelegate<Where>,
  where: Where,
): Promise<number> {
  let removed = 0;
  for (;;) {
    const rows = await delegate.findMany({
      where,
      select: { id: true },
      take: OAUTH_CLEANUP_BATCH,
    });
    if (rows.length === 0) break;
    const { count } = await delegate.deleteMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
    });
    removed += count;
    if (rows.length < OAUTH_CLEANUP_BATCH || count === 0) break;
  }
  return removed;
}

export async function sweepExpiredOAuthArtifacts(
  now: Date = new Date(),
): Promise<OAuthCleanupCounts> {
  const graceCutoff = new Date(now.getTime() - OAUTH_CLEANUP_AUDIT_GRACE_MS);
  const unclaimedCutoff = new Date(now.getTime() - OAUTH_UNCLAIMED_CLIENT_RETENTION_MS);

  const accessTokens = await deleteBatched(prisma.oauthAccessToken, {
    expiresAt: { lte: graceCutoff },
  });
  const refreshTokens = await deleteBatched(prisma.oauthRefreshToken, {
    expiresAt: { lte: graceCutoff },
    oauthAccessTokens: { every: { expiresAt: { lte: graceCutoff } } },
  });
  const clientAssertions = await deleteBatched(prisma.oauthClientAssertion, {
    expiresAt: { lte: graceCutoff },
  });
  const unclaimedClients = await deleteBatched(prisma.oauthClient, {
    clientDiscoveryId: null,
    userId: null,
    referenceId: null,
    createdAt: { lte: unclaimedCutoff },
    oauthConsents: { none: {} },
    oauthRefreshTokens: { none: {} },
    oauthAccessTokens: { none: {} },
  });
  return { accessTokens, refreshTokens, clientAssertions, unclaimedClients };
}
