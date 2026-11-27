import prisma, { type Prisma } from "@cockpit-context/db";
import { archiveUndoIdentifier, lockUserCredentials } from "./ban.js";
import { withLockSlot, withTransactionSlot } from "./lock-slots.js";

/**
 * Which OAuth MCP access a revocation ends: one generation (the user, client
 * and consent reference a grant belongs to), or, with `userId` alone, every
 * generation the user holds.
 */
type OauthRevocationScope = { userId: string; clientId?: string; referenceId?: string };

/**
 * The writes that end OAuth MCP access for `scope`, to run in one
 * `$transaction`: the matching grants become tombstones (`/mcp` refuses them
 * at once, even for an access JWT that has not expired yet, and token
 * issuance refuses them), and the stored access tokens, refresh tokens and
 * remembered consent are deleted, so reconnecting means a new sign-in and a
 * new consent. Shared by connection revocation (one generation), account
 * archiving and password reset (all of a user's).
 */
export function oauthRevocationWrites(
  scope: OauthRevocationScope,
  now = new Date(),
  db: Prisma.TransactionClient = prisma,
): Prisma.PrismaPromise<Prisma.BatchPayload>[] {
  return [
    db.mcpGrant.updateMany({
      where: { ...scope, revokedAt: null },
      data: { revokedAt: now },
    }),
    // Access tokens first: they reference refresh tokens.
    db.oauthAccessToken.deleteMany({ where: scope }),
    db.oauthRefreshToken.deleteMany({ where: scope }),
    db.oauthConsent.deleteMany({ where: scope }),
  ];
}

/** The existing two-key issuance lock, on the caller's transaction client. */
export { lockUserCredentials };

/** Serialize credential issuance and recovery per user across DB connections.
 * READ COMMITTED is deliberate: the session read AFTER waiting for the lock
 * must see a deletion committed while waiting, rather than an earlier snapshot.
 */
export function withUserCredentialTransaction<T>(
  userId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withLockSlot(() =>
    withTransactionSlot(() =>
      prisma.$transaction(
        async (tx) => {
          await lockUserCredentials(tx, userId);
          return run(tx);
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ),
  );
}

/** Cookie-cache copies never authorize standing credentials or live streams. */
export async function hasLiveSession(
  db: Prisma.TransactionClient,
  userId: string,
  sessionId: string | null | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  return (
    (await db.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    })) != null
  );
}

/** Idempotent; failed transactions roll back completely and are safe to retry. */
export async function revokeUserCredentials(
  userId: string,
  {
    revokeSessions = false,
    keepSessionToken,
  }: { revokeSessions?: boolean; keepSessionToken?: string } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withUserCredentialTransaction(userId, async (tx) => {
        await revokeUserCredentialsInTransaction(tx, userId, { revokeSessions, keepSessionToken });
      });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export { archiveUndoIdentifier } from "./ban.js";

/** Caller owns the existing credential lock; never opens another transaction. */
export async function revokeUserCredentialsInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  {
    revokeSessions = false,
    keepSessionToken,
  }: { revokeSessions?: boolean; keepSessionToken?: string } = {},
): Promise<void> {
  const now = new Date();
  await tx.mcpAgentToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  for (const write of oauthRevocationWrites({ userId }, now, tx)) await write;
  await tx.verification.deleteMany({ where: { identifier: archiveUndoIdentifier(userId) } });
  // Better Auth 1.7.18 two-factor: challenges and trusted devices store
  // the user ID as value; OTP hashes and attempt counters instead refer
  // to the challenge identifier. Delete all of them in one statement so
  // the sibling lookup sees the challenges before they are removed.
  // Set-based SQL avoids loading an unbounded challenge list into memory.
  await tx.$executeRaw`
  WITH challenges AS (
    SELECT "identifier" FROM "verification"
    WHERE "value" = ${userId} AND "identifier" LIKE '2fa-%'
  )
  DELETE FROM "verification"
  WHERE ("value" = ${userId} AND "identifier" LIKE 'trust-device-%')
    OR "identifier" IN (
      SELECT "identifier" FROM challenges
      UNION ALL
      SELECT '2fa-otp-' || "identifier" FROM challenges
      UNION ALL
      SELECT '2fa-attempts-' || "identifier" FROM challenges
    )
`;
  // Delete every session before releasing the issuance lock, so even a
  // signed cookie-cache copy cannot mint in the password-reset gap.
  // Auth has no server-side session cache or secondary storage to purge.
  if (revokeSessions)
    await tx.session.deleteMany({
      where: { userId, ...(keepSessionToken ? { token: { not: keepSessionToken } } : {}) },
    });
}
