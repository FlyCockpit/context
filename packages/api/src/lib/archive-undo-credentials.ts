import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ArchiveUndoSnapshot,
  clearArchiveUndoRecords,
  parseArchiveUndoSnapshot,
  pruneArchiveUndoCredentials,
} from "@cockpit-context/auth/archive-undo-snapshot";
import { archiveUndoIdentifier } from "@cockpit-context/auth/ban";
import type { Prisma } from "@cockpit-context/db";
import { ORPCError } from "@orpc/server";
import { forEachPage, keysetWhere } from "./pagination";

/**
 * How long the archive-undo credential snapshot stays redeemable. Outlasts the
 * admin toast (`ARCHIVE_UNDO_TOAST_MS`) and expires naturally for cleanup via
 * `reap-expired-auth-tokens`.
 */
const ARCHIVE_UNDO_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_UNDO_PAGE_SIZE = 200;

type JsonValue = Prisma.InputJsonValue;

export { clearArchiveUndoRecords, pruneArchiveUndoCredentials };

type CapturedArchiveCredentials = Omit<
  ArchiveUndoSnapshot,
  "version" | "revokedAtMs" | "tokenHash"
>;

function hashUndoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function digestsEqual(actualHexOrB64: string, expected: string): boolean {
  const a = Buffer.from(actualHexOrB64, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function collectPagedRows<T extends { id: string }>(
  fetchPage: (args: { take: number; afterId?: string }) => Promise<T[] | undefined>,
): Promise<T[]> {
  const collected: T[] = [];
  await forEachPage(
    async (args) => (await fetchPage(args)) ?? [],
    ARCHIVE_UNDO_PAGE_SIZE,
    (rows) => {
      collected.push(...rows);
    },
  );
  return collected;
}

/**
 * Captures the user's currently active MCP connections (`McpAgentToken`,
 * `McpGrant`) and OAuth connections (`OauthConsent`, non-revoked/non-expired
 * `OauthRefreshToken` and `OauthAccessToken`) immediately BEFORE archive
 * revokes or deletes them inside the same locked transaction.
 */
export async function captureArchiveUndoCredentials(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<CapturedArchiveCredentials> {
  const mcpTokens = await collectPagedRows(({ take, afterId }) =>
    tx.mcpAgentToken.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...keysetWhere(afterId),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    }),
  );
  const mcpGrants = await collectPagedRows(({ take, afterId }) =>
    tx.mcpGrant.findMany({
      where: { userId, revokedAt: null, ...keysetWhere(afterId) },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    }),
  );
  const oauthConsents = await collectPagedRows(({ take, afterId }) =>
    tx.oauthConsent.findMany({
      where: { userId, ...keysetWhere(afterId) },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        clientId: true,
        referenceId: true,
        resources: true,
        requestedUserInfoClaims: true,
        scopes: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );
  const oauthRefreshTokens = await collectPagedRows(({ take, afterId }) =>
    tx.oauthRefreshToken.findMany({
      where: { userId, revoked: null, expiresAt: { gt: now }, ...keysetWhere(afterId) },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        token: true,
        clientId: true,
        referenceId: true,
        authorizationCodeId: true,
        resources: true,
        requestedUserInfoClaims: true,
        expiresAt: true,
        createdAt: true,
        rotatedAt: true,
        rotationReplayResponse: true,
        rotationReplayExpiresAt: true,
        authTime: true,
        confirmation: true,
        scopes: true,
      },
    }),
  );
  const oauthAccessTokens = await collectPagedRows(({ take, afterId }) =>
    tx.oauthAccessToken.findMany({
      where: { userId, revoked: null, expiresAt: { gt: now }, ...keysetWhere(afterId) },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        token: true,
        clientId: true,
        referenceId: true,
        authorizationCodeId: true,
        resources: true,
        requestedUserInfoClaims: true,
        refreshId: true,
        expiresAt: true,
        createdAt: true,
        confirmation: true,
        scopes: true,
      },
    }),
  );

  return {
    mcpAgentTokenIds: mcpTokens.map((row) => row.id),
    mcpGrantIds: mcpGrants.map((row) => row.id),
    oauthConsents: oauthConsents.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      referenceId: row.referenceId,
      resources: row.resources,
      requestedUserInfoClaims: row.requestedUserInfoClaims,
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    oauthRefreshTokens: oauthRefreshTokens.map((row) => ({
      id: row.id,
      token: row.token,
      clientId: row.clientId,
      referenceId: row.referenceId,
      authorizationCodeId: row.authorizationCodeId,
      resources: row.resources,
      requestedUserInfoClaims: row.requestedUserInfoClaims,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
      rotationReplayResponse: row.rotationReplayResponse,
      rotationReplayExpiresAt: row.rotationReplayExpiresAt
        ? row.rotationReplayExpiresAt.toISOString()
        : null,
      authTime: row.authTime ? row.authTime.toISOString() : null,
      confirmation: row.confirmation as JsonValue | null,
      scopes: row.scopes,
    })),
    oauthAccessTokens: oauthAccessTokens.map((row) => ({
      id: row.id,
      token: row.token,
      clientId: row.clientId,
      referenceId: row.referenceId,
      authorizationCodeId: row.authorizationCodeId,
      resources: row.resources,
      requestedUserInfoClaims: row.requestedUserInfoClaims,
      refreshId: row.refreshId,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      confirmation: row.confirmation as JsonValue | null,
      scopes: row.scopes,
    })),
  };
}

/**
 * Replaces any older archive-undo token for `userId` and persists the hashed
 * one-time snapshot in `Verification`. Returns the plaintext `undoToken`.
 */
export async function writeArchiveUndoRecord(
  tx: Prisma.TransactionClient,
  userId: string,
  captured: CapturedArchiveCredentials,
  now: Date,
): Promise<string> {
  const undoToken = randomBytes(32).toString("base64url");
  const snapshot: ArchiveUndoSnapshot = {
    version: 1,
    revokedAtMs: now.getTime(),
    tokenHash: hashUndoToken(undoToken),
    ...captured,
  };
  await clearArchiveUndoRecords(tx, userId);
  await tx.verification.create({
    data: {
      identifier: archiveUndoIdentifier(userId),
      value: JSON.stringify(snapshot),
      expiresAt: new Date(now.getTime() + ARCHIVE_UNDO_TTL_MS),
    },
  });
  return undoToken;
}

/**
 * Restores ONLY the active MCP connections (`McpAgentToken`, `McpGrant` still
 * stamped with the archive's exact `revokedAt`) and non-expired OAuth connections
 * removed by the matching `users.archive` call. Never resurrects previously
 * revoked credentials, and fails closed if `undoToken` mismatches a live record.
 */
export async function restoreArchiveUndoCredentials(
  tx: Prisma.TransactionClient,
  userId: string,
  undoToken: string,
  now: Date,
): Promise<boolean> {
  const row = await tx.verification.findFirst({
    where: { identifier: archiveUndoIdentifier(userId) },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.expiresAt <= now) {
    await clearArchiveUndoRecords(tx, userId);
    return false;
  }
  const snapshot = parseArchiveUndoSnapshot(row.value);
  if (!snapshot) {
    await clearArchiveUndoRecords(tx, userId);
    return false;
  }
  if (!digestsEqual(hashUndoToken(undoToken), snapshot.tokenHash)) {
    throw new ORPCError("FORBIDDEN", { message: "Invalid archive undo token." });
  }

  await clearArchiveUndoRecords(tx, userId);

  const archivedAt = new Date(snapshot.revokedAtMs);
  if (snapshot.mcpAgentTokenIds.length > 0) {
    await tx.mcpAgentToken.updateMany({
      where: {
        id: { in: snapshot.mcpAgentTokenIds },
        userId,
        revokedAt: archivedAt,
      },
      data: { revokedAt: null },
    });
  }
  if (snapshot.mcpGrantIds.length > 0) {
    await tx.mcpGrant.updateMany({
      where: {
        id: { in: snapshot.mcpGrantIds },
        userId,
        revokedAt: archivedAt,
      },
      data: { revokedAt: null },
    });
  }

  const candidateClientIds = [
    ...new Set([
      ...snapshot.oauthConsents.map((rowItem) => rowItem.clientId),
      ...snapshot.oauthRefreshTokens.map((rowItem) => rowItem.clientId),
      ...snapshot.oauthAccessTokens.map((rowItem) => rowItem.clientId),
    ]),
  ];
  const liveClientIds = new Set<string>();
  for (let i = 0; i < candidateClientIds.length; i += ARCHIVE_UNDO_PAGE_SIZE) {
    const chunk = candidateClientIds.slice(i, i + ARCHIVE_UNDO_PAGE_SIZE);
    const rows =
      (await tx.oauthClient.findMany({
        where: { clientId: { in: chunk } },
        take: chunk.length,
        select: { clientId: true },
      })) ?? [];
    for (const client of rows) liveClientIds.add(client.clientId);
  }

  const consentsToRestore = snapshot.oauthConsents.filter((c) => liveClientIds.has(c.clientId));
  if (consentsToRestore.length > 0) {
    await tx.oauthConsent.createMany({
      data: consentsToRestore.map((c) => ({
        id: c.id,
        clientId: c.clientId,
        userId,
        referenceId: c.referenceId,
        resources: c.resources,
        requestedUserInfoClaims: c.requestedUserInfoClaims,
        scopes: c.scopes,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
      })),
      skipDuplicates: true,
    });
  }

  const refreshToRestore = snapshot.oauthRefreshTokens.filter(
    (r) => liveClientIds.has(r.clientId) && new Date(r.expiresAt) > now,
  );
  if (refreshToRestore.length > 0) {
    await tx.oauthRefreshToken.createMany({
      data: refreshToRestore.map((r) => ({
        id: r.id,
        token: r.token,
        clientId: r.clientId,
        sessionId: null,
        userId,
        referenceId: r.referenceId,
        authorizationCodeId: r.authorizationCodeId,
        resources: r.resources,
        requestedUserInfoClaims: r.requestedUserInfoClaims,
        expiresAt: new Date(r.expiresAt),
        createdAt: new Date(r.createdAt),
        revoked: null,
        rotatedAt: r.rotatedAt ? new Date(r.rotatedAt) : null,
        rotationReplayResponse: r.rotationReplayResponse,
        rotationReplayExpiresAt: r.rotationReplayExpiresAt
          ? new Date(r.rotationReplayExpiresAt)
          : null,
        authTime: r.authTime ? new Date(r.authTime) : null,
        ...(r.confirmation !== null ? { confirmation: r.confirmation } : {}),
        scopes: r.scopes,
      })),
      skipDuplicates: true,
    });
  }

  const liveRefreshIds = new Set(refreshToRestore.map((r) => r.id));
  const accessToRestore = snapshot.oauthAccessTokens.filter(
    (a) => liveClientIds.has(a.clientId) && new Date(a.expiresAt) > now,
  );
  if (accessToRestore.length > 0) {
    await tx.oauthAccessToken.createMany({
      data: accessToRestore.map((a) => ({
        id: a.id,
        token: a.token,
        clientId: a.clientId,
        sessionId: null,
        userId,
        referenceId: a.referenceId,
        authorizationCodeId: a.authorizationCodeId,
        resources: a.resources,
        requestedUserInfoClaims: a.requestedUserInfoClaims,
        refreshId: a.refreshId && liveRefreshIds.has(a.refreshId) ? a.refreshId : null,
        expiresAt: new Date(a.expiresAt),
        createdAt: new Date(a.createdAt),
        revoked: null,
        ...(a.confirmation !== null ? { confirmation: a.confirmation } : {}),
        scopes: a.scopes,
      })),
      skipDuplicates: true,
    });
  }

  return true;
}
