import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@cockpit-context/db";
import { APIError } from "better-auth/api";
import { decodeBasicCredentials, stripAccessTokenAuthorizationScheme } from "better-auth/oauth2";
import { ARCHIVE_UNDO_IDENTIFIER_PREFIX, archiveUndoIdentifier } from "./ban.js";

const ARCHIVE_UNDO_SCAN_PAGE_SIZE = 200;
const OAUTH_FAMILY_REVOKE_FENCE_PREFIX = "oauth-family-revoke-fence:";
const OAUTH_REVOKE_FENCE_TTL_MS = 5 * 60 * 1000;

type ArchiveUndoVerificationWriter = {
  verification: {
    findFirst: Pick<Prisma.TransactionClient["verification"], "findFirst">["findFirst"];
    deleteMany: Pick<Prisma.TransactionClient["verification"], "deleteMany">["deleteMany"];
    create: Pick<Prisma.TransactionClient["verification"], "create">["create"];
  };
};

interface SerializedOauthConsent {
  id: string;
  clientId: string;
  referenceId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

interface SerializedOauthRefreshToken {
  id: string;
  token: string;
  clientId: string;
  referenceId: string | null;
  authorizationCodeId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  expiresAt: string;
  createdAt: string;
  rotatedAt: string | null;
  rotationReplayResponse: string | null;
  rotationReplayExpiresAt: string | null;
  authTime: string | null;
  confirmation: Prisma.InputJsonValue | null;
  scopes: string[];
}

interface SerializedOauthAccessToken {
  id: string;
  token: string;
  clientId: string;
  referenceId: string | null;
  authorizationCodeId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  refreshId: string | null;
  expiresAt: string;
  createdAt: string;
  confirmation: Prisma.InputJsonValue | null;
  scopes: string[];
}

export interface ArchiveUndoSnapshot {
  version: 1;
  revokedAtMs: number;
  tokenHash: string;
  mcpAgentTokenIds: string[];
  mcpGrantIds: string[];
  oauthConsents: SerializedOauthConsent[];
  oauthRefreshTokens: SerializedOauthRefreshToken[];
  oauthAccessTokens: SerializedOauthAccessToken[];
}

interface ArchiveUndoPruneFilter {
  mcpTokenId?: string;
  mcpGrantId?: string;
  clientId?: string;
  referenceId?: string;
  oauthRefreshTokenHash?: string;
  oauthRefreshTokenHashes?: string[];
  oauthAccessTokenHash?: string;
  removeRefreshFamilyForClient?: boolean;
  scopedAuthCodeIds?: string[];
  fencedAtMs?: number;
}

function hashOauthProviderToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("base64url");
}

export function parseArchiveUndoSnapshot(raw: string): ArchiveUndoSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveUndoSnapshot>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.revokedAtMs !== "number" ||
      typeof parsed.tokenHash !== "string" ||
      !Array.isArray(parsed.mcpAgentTokenIds) ||
      !Array.isArray(parsed.mcpGrantIds) ||
      !Array.isArray(parsed.oauthConsents) ||
      !Array.isArray(parsed.oauthRefreshTokens) ||
      !Array.isArray(parsed.oauthAccessTokens)
    ) {
      return null;
    }
    return parsed as ArchiveUndoSnapshot;
  } catch {
    return null;
  }
}

/**
 * Deletes every stored archive-undo snapshot for `userId`. Called whenever a
 * non-undo restore (`unarchive` without token) or credential reset invalidates
 * any in-flight Undo toast.
 */
export async function clearArchiveUndoRecords(
  tx: {
    verification: {
      deleteMany: Pick<Prisma.TransactionClient["verification"], "deleteMany">["deleteMany"];
    };
  },
  userId: string,
): Promise<void> {
  await tx.verification.deleteMany({
    where: { identifier: archiveUndoIdentifier(userId) },
  });
}

function applyArchiveUndoPrune(
  snapshot: ArchiveUndoSnapshot,
  removed: ArchiveUndoPruneFilter,
): boolean {
  let changed = false;

  if (removed.mcpTokenId && snapshot.mcpAgentTokenIds.includes(removed.mcpTokenId)) {
    snapshot.mcpAgentTokenIds = snapshot.mcpAgentTokenIds.filter((id) => id !== removed.mcpTokenId);
    changed = true;
  }
  if (removed.mcpGrantId && snapshot.mcpGrantIds.includes(removed.mcpGrantId)) {
    snapshot.mcpGrantIds = snapshot.mcpGrantIds.filter((id) => id !== removed.mcpGrantId);
    changed = true;
  }

  if (
    removed.oauthRefreshTokenHash ||
    (removed.oauthRefreshTokenHashes?.length ?? 0) > 0 ||
    (removed.removeRefreshFamilyForClient && removed.clientId)
  ) {
    const removedRefreshIds = new Set<string>();
    const scopedCodes = removed.scopedAuthCodeIds?.filter(Boolean) ?? [];
    const matchHashes = new Set<string>([
      ...(removed.oauthRefreshTokenHash ? [removed.oauthRefreshTokenHash] : []),
      ...(removed.oauthRefreshTokenHashes ?? []),
    ]);
    const matchesFamily = (row: {
      clientId: string;
      authorizationCodeId: string | null;
      createdAt: string;
    }) =>
      (!removed.clientId || row.clientId === removed.clientId) &&
      Boolean(removed.removeRefreshFamilyForClient) &&
      (scopedCodes.length > 0
        ? row.authorizationCodeId !== null && scopedCodes.includes(row.authorizationCodeId)
        : row.authorizationCodeId === null &&
          (removed.fencedAtMs === undefined || Date.parse(row.createdAt) <= removed.fencedAtMs));

    const nextRefresh = snapshot.oauthRefreshTokens.filter((row) => {
      const clientMatches = !removed.clientId || row.clientId === removed.clientId;
      const hashMatches = matchHashes.has(row.token);
      const match = (clientMatches && hashMatches) || matchesFamily(row);
      if (match) removedRefreshIds.add(row.id);
      return !match;
    });
    const nextAccess = snapshot.oauthAccessTokens.filter((access) => {
      if (access.refreshId && removedRefreshIds.has(access.refreshId)) return false;
      if (matchesFamily(access) && (scopedCodes.length > 0 || access.refreshId !== null)) {
        return false;
      }
      return true;
    });
    if (
      nextRefresh.length !== snapshot.oauthRefreshTokens.length ||
      nextAccess.length !== snapshot.oauthAccessTokens.length
    ) {
      snapshot.oauthRefreshTokens = nextRefresh;
      snapshot.oauthAccessTokens = nextAccess;
      changed = true;
    }
  }

  if (removed.oauthAccessTokenHash) {
    const nextAccess = snapshot.oauthAccessTokens.filter(
      (access) =>
        !(
          access.token === removed.oauthAccessTokenHash &&
          (!removed.clientId || access.clientId === removed.clientId)
        ),
    );
    if (nextAccess.length !== snapshot.oauthAccessTokens.length) {
      snapshot.oauthAccessTokens = nextAccess;
      changed = true;
    }
  }

  if (
    removed.clientId &&
    !removed.oauthRefreshTokenHash &&
    !removed.oauthRefreshTokenHashes?.length &&
    !removed.oauthAccessTokenHash &&
    !removed.removeRefreshFamilyForClient
  ) {
    const matchesGen = (item: { clientId: string; referenceId: string | null }) =>
      item.clientId === removed.clientId &&
      (removed.referenceId === undefined || item.referenceId === removed.referenceId);
    const nextConsents = snapshot.oauthConsents.filter((c) => !matchesGen(c));
    const nextRefresh = snapshot.oauthRefreshTokens.filter((r) => !matchesGen(r));
    const nextAccess = snapshot.oauthAccessTokens.filter((a) => !matchesGen(a));
    if (
      nextConsents.length !== snapshot.oauthConsents.length ||
      nextRefresh.length !== snapshot.oauthRefreshTokens.length ||
      nextAccess.length !== snapshot.oauthAccessTokens.length
    ) {
      snapshot.oauthConsents = nextConsents;
      snapshot.oauthRefreshTokens = nextRefresh;
      snapshot.oauthAccessTokens = nextAccess;
      changed = true;
    }
  }

  return changed;
}

/**
 * Prunes manually or OAuth-revoked credentials from any pending `archive-undo`
 * snapshot inside the caller's user credential lock, so a revocation completing
 * after archive is never undone by toast Undo.
 */
export async function pruneArchiveUndoCredentials(
  tx: ArchiveUndoVerificationWriter,
  userId: string,
  removed: ArchiveUndoPruneFilter,
): Promise<void> {
  const row = await tx.verification.findFirst({
    where: { identifier: archiveUndoIdentifier(userId) },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return;
  const snapshot = parseArchiveUndoSnapshot(row.value);
  if (!snapshot) {
    await clearArchiveUndoRecords(tx, userId);
    return;
  }

  if (!applyArchiveUndoPrune(snapshot, removed)) return;

  await clearArchiveUndoRecords(tx, userId);
  await tx.verification.create({
    data: {
      identifier: archiveUndoIdentifier(userId),
      value: JSON.stringify(snapshot),
      expiresAt: row.expiresAt,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractClientIdFromBasicHeader(header: string | null | undefined): string | null {
  if (!header || !/^Basic +/i.test(header)) return null;
  try {
    const { clientId } = decodeBasicCredentials(header);
    return clientId.length > 0 ? clientId : null;
  } catch {
    return null;
  }
}

function extractClientIdFromAssertion(assertion: unknown): string | null {
  if (typeof assertion !== "string") return null;
  const parts = assertion.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return null;
    if (typeof payload.sub === "string" && payload.sub.length > 0) return payload.sub;
    if (typeof payload.iss === "string" && payload.iss.length > 0) return payload.iss;
    return null;
  } catch {
    return null;
  }
}

export interface OauthRevokeHookContext {
  body?: unknown;
  headers?: Pick<Headers, "get"> | null;
  request?: { headers?: Pick<Headers, "get"> | null } | null;
  context?: { returned?: unknown } | null;
}

type OauthRevokeDbClient = Pick<
  Prisma.TransactionClient,
  "verification" | "oauthRefreshToken" | "oauthAccessToken"
>;

export type OauthRevokePrisma = OauthRevokeDbClient & {
  $transaction: <T>(
    fn: (tx: OauthRevokeDbClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ) => Promise<T>;
};

interface OauthRevokeCandidateSet {
  allUserIds: Set<string>;
  refreshUserIds: Set<string>;
  authCodeIdsByUser: Map<string, Set<string>>;
}

const NULL_FAMILY_FENCE_KEY = "__nullable__";

interface RefreshTokenIdentityRow {
  userId: string;
  authorizationCodeId: string | null;
  createdAt?: Date;
}

interface PreTokenRefreshState {
  rowsByUser: Map<string, RefreshTokenIdentityRow[]>;
  authCodeIdsByUser: Map<string, Set<string>>;
  fenceIdByKey: Map<string, string | null>;
}

interface FamilyFenceState {
  clientId: string;
  fenceId: string;
  active: boolean;
  fencedAtMs: number;
  scopedAuthCodeIds?: string[];
}

const preRevokeCandidatesByContext = new WeakMap<object, OauthRevokeCandidateSet>();
const preTokenRefreshByContext = new WeakMap<object, PreTokenRefreshState>();

function getHookStateKey(ctx: OauthRevokeHookContext): object {
  return ctx.context && typeof ctx.context === "object" ? ctx.context : ctx;
}

function isErrorOutcome(returned: unknown): boolean {
  if (returned instanceof Error) return true;
  if (typeof Response !== "undefined" && returned instanceof Response && !returned.ok) return true;
  return false;
}

function oauthFamilyRevokeFenceIdentifier(
  userId: string,
  clientId: string,
  familyKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${userId}\0${clientId}\0${familyKey}`, "utf8")
    .digest("base64url");
  return `${OAUTH_FAMILY_REVOKE_FENCE_PREFIX}${digest}`;
}

function lookupFamilyFenceKeys(
  tokenRows: ReadonlyArray<{ authorizationCodeId: string | null }>,
): string[] {
  const keys = new Set<string>();
  let sawNullable = false;
  for (const row of tokenRows) {
    if (row.authorizationCodeId) {
      keys.add(row.authorizationCodeId);
    } else {
      sawNullable = true;
    }
  }
  if (sawNullable || keys.size === 0) {
    keys.add(NULL_FAMILY_FENCE_KEY);
  }
  return [...keys];
}

function parseFamilyFenceState(raw: string): FamilyFenceState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FamilyFenceState>;
    if (
      !parsed ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.fenceId !== "string" ||
      parsed.fenceId.length === 0 ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.fencedAtMs !== "number"
    ) {
      return null;
    }
    return {
      clientId: parsed.clientId,
      fenceId: parsed.fenceId,
      active: parsed.active,
      fencedAtMs: parsed.fencedAtMs,
      ...(Array.isArray(parsed.scopedAuthCodeIds)
        ? {
            scopedAuthCodeIds: parsed.scopedAuthCodeIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

async function readFamilyFenceState(
  db: Pick<OauthRevokeDbClient, "verification">,
  userId: string,
  clientId: string,
  familyKey: string,
  now: Date,
): Promise<FamilyFenceState | null> {
  const row = await db.verification.findFirst({
    where: {
      identifier: oauthFamilyRevokeFenceIdentifier(userId, clientId, familyKey),
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    select: { value: true },
  });
  if (!row || typeof row.value !== "string") return null;
  return parseFamilyFenceState(row.value);
}

async function writeFamilyFenceState(
  tx: Pick<OauthRevokeDbClient, "verification">,
  userId: string,
  familyKey: string,
  state: FamilyFenceState,
  now: Date,
): Promise<void> {
  const identifier = oauthFamilyRevokeFenceIdentifier(userId, state.clientId, familyKey);
  await tx.verification.deleteMany({ where: { identifier } });
  await tx.verification.create({
    data: {
      identifier,
      value: JSON.stringify(state),
      expiresAt: new Date(now.getTime() + OAUTH_REVOKE_FENCE_TTL_MS),
    },
  });
}

function recordAuthCodeId(
  map: Map<string, Set<string>>,
  userId: string,
  authCodeId: string | null | undefined,
): void {
  if (!authCodeId) return;
  let set = map.get(userId);
  if (!set) {
    set = new Set<string>();
    map.set(userId, set);
  }
  set.add(authCodeId);
}

interface ParsedOauthRevokeTarget {
  clientId: string;
  tokenHash: string;
  filter: ArchiveUndoPruneFilter;
}

function parseOauthRevokeTarget(ctx: OauthRevokeHookContext): ParsedOauthRevokeTarget | null {
  if (!isRecord(ctx.body) || typeof ctx.body.token !== "string") return null;

  const rawToken = stripAccessTokenAuthorizationScheme(ctx.body.token);
  if (!rawToken) return null;

  const clientId = extractClientIdFromHook(ctx);
  if (!clientId) return null;

  const tokenHash = hashOauthProviderToken(rawToken);
  const rawHint = ctx.body.token_type_hint;
  const tokenTypeHint =
    rawHint === "access_token" || rawHint === "refresh_token" ? rawHint : undefined;

  const filter: ArchiveUndoPruneFilter = {
    clientId,
    ...(tokenTypeHint !== "access_token" ? { oauthRefreshTokenHash: tokenHash } : {}),
    ...(tokenTypeHint !== "refresh_token" ? { oauthAccessTokenHash: tokenHash } : {}),
  };

  return { clientId, tokenHash, filter };
}

async function collectMatchingCandidates(
  snapTx: OauthRevokeDbClient,
  clientId: string,
  tokenHash: string,
  filter: ArchiveUndoPruneFilter,
  now: Date,
): Promise<OauthRevokeCandidateSet> {
  const allUserIds = new Set<string>();
  const refreshUserIds = new Set<string>();
  const authCodeIdsByUser = new Map<string, Set<string>>();

  let afterId: string | undefined;
  for (;;) {
    const rows = await snapTx.verification.findMany({
      where: {
        identifier: { startsWith: ARCHIVE_UNDO_IDENTIFIER_PREFIX },
        expiresAt: { gt: now },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
      select: { id: true, identifier: true, value: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.value.includes(tokenHash)) continue;
      const snapshot = parseArchiveUndoSnapshot(row.value);
      if (!snapshot) continue;
      const userId = row.identifier.slice(ARCHIVE_UNDO_IDENTIFIER_PREFIX.length);
      if (!userId) continue;

      const matchedSnapshotRefresh = filter.oauthRefreshTokenHash
        ? snapshot.oauthRefreshTokens.filter(
            (r) => r.token === filter.oauthRefreshTokenHash && r.clientId === clientId,
          )
        : [];
      if (matchedSnapshotRefresh.length > 0) {
        allUserIds.add(userId);
        refreshUserIds.add(userId);
        for (const r of matchedSnapshotRefresh) {
          recordAuthCodeId(authCodeIdsByUser, userId, r.authorizationCodeId);
        }
        continue;
      }

      if (applyArchiveUndoPrune({ ...snapshot }, filter)) {
        allUserIds.add(userId);
      }
    }

    if (rows.length < ARCHIVE_UNDO_SCAN_PAGE_SIZE) break;
    afterId = rows.at(-1)?.id;
  }

  // Close any race where Undo restored the token (and/or a concurrent refresh
  // rotated it) into DB before hooks.after ran, or provider cleanup deleted
  // the rotated row before hooks.after observed it: capture both in hooks.before
  // and hooks.after inside a RepeatableRead DB snapshot.
  if (filter.oauthRefreshTokenHash) {
    let afterRtId: string | undefined;
    for (;;) {
      const rows = await snapTx.oauthRefreshToken.findMany({
        where: {
          clientId,
          token: tokenHash,
          OR: [{ revoked: null }, { rotatedAt: { not: null } }],
          ...(afterRtId ? { id: { gt: afterRtId } } : {}),
        },
        orderBy: { id: "asc" },
        take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
        select: { id: true, userId: true, authorizationCodeId: true },
      });
      for (const row of rows) {
        if (row.userId) {
          allUserIds.add(row.userId);
          refreshUserIds.add(row.userId);
          recordAuthCodeId(authCodeIdsByUser, row.userId, row.authorizationCodeId);
        }
      }
      if (rows.length < ARCHIVE_UNDO_SCAN_PAGE_SIZE) break;
      afterRtId = rows.at(-1)?.id;
    }
  }

  if (filter.oauthAccessTokenHash) {
    let afterAtId: string | undefined;
    for (;;) {
      const rows = await snapTx.oauthAccessToken.findMany({
        where: {
          clientId,
          token: tokenHash,
          ...(afterAtId ? { id: { gt: afterAtId } } : {}),
        },
        orderBy: { id: "asc" },
        take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
        select: { id: true, userId: true },
      });
      for (const row of rows) {
        if (row.userId) allUserIds.add(row.userId);
      }
      if (rows.length < ARCHIVE_UNDO_SCAN_PAGE_SIZE) break;
      afterAtId = rows.at(-1)?.id;
    }
  }

  return { allUserIds, refreshUserIds, authCodeIdsByUser };
}

async function invalidateOauthRefreshFamilyInTransaction(
  tx: OauthRevokeDbClient,
  userId: string,
  clientId: string,
  now: Date,
  scopedAuthCodeIds?: string[],
  extraTokenHashes?: string[],
  fencedAtMs?: number,
): Promise<void> {
  const codes = scopedAuthCodeIds?.filter(Boolean) ?? [];
  const hashes = [...new Set(extraTokenHashes?.filter(Boolean) ?? [])];

  if (codes.length > 0) {
    await tx.oauthAccessToken.deleteMany({
      where: {
        userId,
        clientId,
        authorizationCodeId: { in: codes },
      },
    });
    await tx.oauthRefreshToken.updateMany({
      where: {
        userId,
        clientId,
        revoked: null,
        OR: [
          { authorizationCodeId: { in: codes } },
          ...(hashes.length > 0 ? [{ token: { in: hashes } }] : []),
        ],
      },
      data: { revoked: now },
    });
    return;
  }

  // Even when nullable authorizationCodeId rows leave scopedAuthCodeIds empty,
  // never issue an unscoped update across all client tokens (which could revoke
  // a concurrent fresh authorization_code grant before its after-hook locks).
  const fenceCutoff = new Date(fencedAtMs ?? now.getTime());
  const staleRows =
    hashes.length > 0
      ? await tx.oauthRefreshToken.findMany({
          where: { userId, clientId, token: { in: hashes } },
          orderBy: { id: "asc" },
          take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
          select: { id: true },
        })
      : [];
  const staleRefreshIds = staleRows.map((row) => row.id);

  await tx.oauthAccessToken.deleteMany({
    where: {
      userId,
      clientId,
      refreshId: { not: null },
      OR: [
        { authorizationCodeId: null, createdAt: { lte: fenceCutoff } },
        ...(staleRefreshIds.length > 0 ? [{ refreshId: { in: staleRefreshIds } }] : []),
      ],
    },
  });
  await tx.oauthRefreshToken.updateMany({
    where: {
      userId,
      clientId,
      revoked: null,
      OR: [
        { authorizationCodeId: null, createdAt: { lte: fenceCutoff } },
        ...(hashes.length > 0 ? [{ token: { in: hashes } }] : []),
      ],
    },
    data: { revoked: now },
  });
}

async function revokeSpecificRefreshHashesInTransaction(
  tx: OauthRevokeDbClient,
  userId: string,
  clientId: string,
  tokenHashes: string[],
  accessTokenHash: string | null,
  now: Date,
): Promise<void> {
  const uniqueHashes = [...new Set(tokenHashes.filter(Boolean))];
  if (uniqueHashes.length > 0) {
    const rows = await tx.oauthRefreshToken.findMany({
      where: { userId, clientId, token: { in: uniqueHashes } },
      orderBy: { id: "asc" },
      take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
      select: { id: true, revoked: true },
    });
    const liveIds = rows.filter((row) => row.revoked === null).map((row) => row.id);
    if (liveIds.length > 0) {
      await tx.oauthRefreshToken.updateMany({
        where: { id: { in: liveIds }, revoked: null },
        data: { revoked: now },
      });
    }
    const allIds = rows.map((row) => row.id);
    if (allIds.length > 0) {
      await tx.oauthAccessToken.deleteMany({
        where: { userId, clientId, refreshId: { in: allIds } },
      });
    }
  }
  if (accessTokenHash) {
    await tx.oauthAccessToken.deleteMany({
      where: { userId, clientId, token: accessTokenHash },
    });
  }
}

async function revokeRestoredOauthTokensInTransaction(
  tx: OauthRevokeDbClient,
  userId: string,
  clientId: string,
  filter: ArchiveUndoPruneFilter,
  now: Date,
  familyFenced: boolean,
  scopedAuthCodeIds: string[],
): Promise<void> {
  if (filter.oauthRefreshTokenHash) {
    const matchedRows = await tx.oauthRefreshToken.findMany({
      where: {
        userId,
        clientId,
        token: filter.oauthRefreshTokenHash,
      },
      orderBy: { id: "asc" },
      take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
      select: { id: true, revoked: true, rotatedAt: true, authorizationCodeId: true },
    });
    const liveIds = matchedRows.filter((row) => row.revoked === null).map((row) => row.id);
    const rotatedSeen = matchedRows.some((row) => row.rotatedAt !== null);

    let casMissed = false;
    if (liveIds.length > 0) {
      const updated = await tx.oauthRefreshToken.updateMany({
        where: { id: { in: liveIds }, revoked: null },
        data: { revoked: now },
      });
      casMissed = updated.count < liveIds.length;
    }

    if (
      familyFenced ||
      rotatedSeen ||
      casMissed ||
      (matchedRows.length === 0 && filter.removeRefreshFamilyForClient)
    ) {
      const mergedCodes = [
        ...new Set([
          ...scopedAuthCodeIds,
          ...matchedRows
            .map((row) => row.authorizationCodeId)
            .filter((id): id is string => Boolean(id)),
        ]),
      ];
      await invalidateOauthRefreshFamilyInTransaction(
        tx,
        userId,
        clientId,
        now,
        mergedCodes,
        [filter.oauthRefreshTokenHash],
        filter.fencedAtMs ?? now.getTime(),
      );
    } else if (liveIds.length > 0) {
      await tx.oauthAccessToken.deleteMany({
        where: { userId, refreshId: { in: liveIds } },
      });
    }
  }

  if (filter.oauthAccessTokenHash) {
    await tx.oauthAccessToken.deleteMany({
      where: { userId, clientId, token: filter.oauthAccessTokenHash },
    });
  }
}

function extractClientIdFromHook(ctx: OauthRevokeHookContext): string | null {
  if (!isRecord(ctx.body)) return null;
  const authHeader = (ctx.headers ?? ctx.request?.headers)?.get("authorization");
  return (
    extractClientIdFromBasicHeader(authHeader) ??
    (typeof ctx.body.client_id === "string" && ctx.body.client_id.length > 0
      ? ctx.body.client_id
      : null) ??
    extractClientIdFromAssertion(ctx.body.client_assertion)
  );
}

/**
 * Before `/api/auth/oauth2/revoke` runs, snapshots matching user identities
 * inside a RepeatableRead DB transaction so rotated or provider-deleted families
 * remain attributable even if provider cleanup deletes the presented token
 * before `hooks.after` runs.
 */
export async function snapshotOauthRevokeCandidates({
  prisma,
  ctx,
  now = new Date(),
}: {
  prisma: OauthRevokePrisma;
  ctx: OauthRevokeHookContext;
  now?: Date;
}): Promise<void> {
  const target = parseOauthRevokeTarget(ctx);
  if (!target) return;

  const candidates = await prisma.$transaction(
    (snapTx) =>
      collectMatchingCandidates(snapTx, target.clientId, target.tokenHash, target.filter, now),
    { isolationLevel: "RepeatableRead" },
  );

  preRevokeCandidatesByContext.set(getHookStateKey(ctx), candidates);
}

/**
 * After `/api/auth/oauth2/revoke` succeeds (HTTP 200), merges pre- and post-
 * revoke candidate sets and, inside `withUserCredentialTransaction`, atomically
 * writes the generation-tracked `(userId, clientId)` family fence, prunes Undo
 * snapshots, and revokes any restored or rotated tokens.
 */
export async function pruneArchiveUndoAfterOauthRevoke({
  prisma,
  lockAndRun,
  ctx,
  now = new Date(),
}: {
  prisma: OauthRevokePrisma;
  lockAndRun: (userId: string, fn: (tx: OauthRevokeDbClient) => Promise<void>) => Promise<void>;
  ctx: OauthRevokeHookContext;
  now?: Date;
}): Promise<void> {
  const stateKey = getHookStateKey(ctx);
  const preCandidates = preRevokeCandidatesByContext.get(stateKey);
  preRevokeCandidatesByContext.delete(stateKey);

  if (isErrorOutcome(ctx.context?.returned)) return;

  const target = parseOauthRevokeTarget(ctx);
  if (!target) return;

  const postCandidates = await prisma.$transaction(
    (snapTx) =>
      collectMatchingCandidates(snapTx, target.clientId, target.tokenHash, target.filter, now),
    { isolationLevel: "RepeatableRead" },
  );

  const allUserIds = new Set<string>([
    ...(preCandidates?.allUserIds ?? []),
    ...postCandidates.allUserIds,
  ]);
  const refreshUserIds = new Set<string>([
    ...(preCandidates?.refreshUserIds ?? []),
    ...postCandidates.refreshUserIds,
  ]);

  if (allUserIds.size === 0) return;

  for (const userId of allUserIds) {
    const isRefreshRevocation = refreshUserIds.has(userId);
    const familyFenced = isRefreshRevocation && Boolean(target.filter.oauthRefreshTokenHash);
    const scopedAuthCodeIds = [
      ...new Set([
        ...(preCandidates?.authCodeIdsByUser.get(userId) ?? []),
        ...(postCandidates.authCodeIdsByUser.get(userId) ?? []),
      ]),
    ];

    const fencedAtMs = now.getTime();
    const userFilter: ArchiveUndoPruneFilter = {
      ...target.filter,
      ...(familyFenced ? { removeRefreshFamilyForClient: true, fencedAtMs } : {}),
      ...(scopedAuthCodeIds.length > 0 ? { scopedAuthCodeIds } : {}),
    };

    await lockAndRun(userId, async (tx) => {
      let lockedCodes = scopedAuthCodeIds;
      if (familyFenced && target.filter.oauthRefreshTokenHash) {
        const dbRows = await tx.oauthRefreshToken.findMany({
          where: { userId, clientId: target.clientId, token: target.filter.oauthRefreshTokenHash },
          orderBy: { id: "asc" },
          take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
          select: { authorizationCodeId: true },
        });
        lockedCodes = [
          ...new Set([
            ...scopedAuthCodeIds,
            ...dbRows.map((r) => r.authorizationCodeId).filter((id): id is string => Boolean(id)),
          ]),
        ];

        const fenceKeys = lockedCodes.length > 0 ? lockedCodes : [NULL_FAMILY_FENCE_KEY];
        for (const familyKey of fenceKeys) {
          await writeFamilyFenceState(
            tx,
            userId,
            familyKey,
            {
              clientId: target.clientId,
              fenceId: randomUUID(),
              active: true,
              fencedAtMs,
              ...(lockedCodes.length > 0 ? { scopedAuthCodeIds: lockedCodes } : {}),
            },
            now,
          );
        }
      }

      const lockedFilter: ArchiveUndoPruneFilter = {
        ...userFilter,
        ...(lockedCodes.length > 0 ? { scopedAuthCodeIds: lockedCodes } : {}),
      };
      await pruneArchiveUndoCredentials(tx, userId, lockedFilter);
      await revokeRestoredOauthTokensInTransaction(
        tx,
        userId,
        target.clientId,
        lockedFilter,
        now,
        familyFenced,
        lockedCodes,
      );
    });
  }
}

function tokenBelongsToFencedFamily(
  fence: FamilyFenceState,
  candidateAuthCodeIds: Iterable<string>,
  tokenRows: ReadonlyArray<{ authorizationCodeId: string | null; createdAt?: Date }>,
): boolean {
  const fencedCodes = fence.scopedAuthCodeIds?.filter(Boolean) ?? [];
  const candCodes = [...new Set([...candidateAuthCodeIds].filter(Boolean))];

  if (fencedCodes.length > 0) {
    if (candCodes.some((code) => fencedCodes.includes(code))) return true;
    if (candCodes.length === 0 && tokenRows.length > 0) {
      return tokenRows.every(
        (r) =>
          r.authorizationCodeId === null &&
          (r.createdAt === undefined || r.createdAt.getTime() <= fence.fencedAtMs),
      );
    }
    return false;
  }

  if (candCodes.length > 0) return false;
  return tokenRows.some(
    (r) =>
      r.authorizationCodeId === null &&
      (r.createdAt === undefined || r.createdAt.getTime() <= fence.fencedAtMs),
  );
}

async function lookupRefreshTokens(
  prisma: Pick<OauthRevokeDbClient, "oauthRefreshToken">,
  clientId: string,
  tokenHash: string,
): Promise<RefreshTokenIdentityRow[]> {
  const rows = await prisma.oauthRefreshToken.findMany({
    where: { clientId, token: tokenHash },
    orderBy: { id: "asc" },
    take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
    select: { userId: true, authorizationCodeId: true, createdAt: true },
  });
  return rows.filter((row): row is RefreshTokenIdentityRow & { createdAt: Date } =>
    Boolean(row.userId),
  );
}

/**
 * Before `/api/auth/oauth2/token` runs on `grant_type: "refresh_token"`,
 * records the presented refresh token's `userId`s, `authorizationCodeId`s, and
 * observed unique `fenceId`s (before rotation can overwrite or delete them),
 * and blocks rotation immediately only when the token belongs to an active
 * family fence for `(userId, clientId)`.
 */
export async function snapshotOauthTokenRequest({
  prisma,
  ctx,
  now = new Date(),
}: {
  prisma: OauthRevokePrisma;
  ctx: OauthRevokeHookContext;
  now?: Date;
}): Promise<void> {
  if (!isRecord(ctx.body) || ctx.body.grant_type !== "refresh_token") return;
  if (typeof ctx.body.refresh_token !== "string" || ctx.body.refresh_token.length === 0) return;

  const clientId = extractClientIdFromHook(ctx);
  if (!clientId) return;

  const tokenHash = hashOauthProviderToken(ctx.body.refresh_token);
  const rows = await lookupRefreshTokens(prisma, clientId, tokenHash);
  const rowsByUser = new Map<string, RefreshTokenIdentityRow[]>();
  const authCodeIdsByUser = new Map<string, Set<string>>();

  for (const row of rows) {
    const list = rowsByUser.get(row.userId) ?? [];
    list.push(row);
    rowsByUser.set(row.userId, list);
    recordAuthCodeId(authCodeIdsByUser, row.userId, row.authorizationCodeId);
  }

  const fenceIdByKey = new Map<string, string | null>();
  for (const [userId, userRows] of rowsByUser) {
    const userCodes = authCodeIdsByUser.get(userId) ?? new Set<string>();
    for (const familyKey of lookupFamilyFenceKeys(userRows)) {
      const state = await readFamilyFenceState(prisma, userId, clientId, familyKey, now);
      if (state?.active && tokenBelongsToFencedFamily(state, userCodes, userRows)) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_grant",
          error_description: "Refresh token has been revoked",
        });
      }
      fenceIdByKey.set(`${userId}\0${familyKey}`, state?.fenceId ?? null);
    }
  }

  preTokenRefreshByContext.set(getHookStateKey(ctx), {
    rowsByUser,
    authCodeIdsByUser,
    fenceIdByKey,
  });
}

/**
 * After `/api/auth/oauth2/token` finishes:
 * - On `grant_type: "authorization_code"`, clears only an ACTIVE nullable
 *   family fence inside `lockAndRun(userId)` (preserving its unique `fenceId`
 *   while setting `active: false`); non-null revoked families keep their own
 *   per-family fence keys until TTL and never disrupt fresh grants or other families.
 * - On `grant_type: "refresh_token"`, establishes family membership against each
 *   matching per-family fence key before locking, rejecting or revoking stale
 *   tokens without letting another revocation overwrite an active family fence.
 */
export async function enforceOauthRefreshRevokeFence({
  prisma,
  lockAndRun,
  ctx,
  now = new Date(),
}: {
  prisma: OauthRevokePrisma;
  lockAndRun: (userId: string, fn: (tx: OauthRevokeDbClient) => Promise<void>) => Promise<void>;
  ctx: OauthRevokeHookContext;
  now?: Date;
}): Promise<void> {
  const stateKey = getHookStateKey(ctx);
  const preState = preTokenRefreshByContext.get(stateKey);
  preTokenRefreshByContext.delete(stateKey);

  if (isErrorOutcome(ctx.context?.returned)) return;
  if (!isRecord(ctx.body)) return;

  const clientId = extractClientIdFromHook(ctx);
  if (!clientId) return;

  const returned = ctx.context?.returned;
  const returnedRecord = isRecord(returned) ? returned : null;

  if (ctx.body.grant_type === "authorization_code") {
    const freshUserIds = new Set<string>();
    const freshRefreshHash =
      typeof returnedRecord?.refresh_token === "string" && returnedRecord.refresh_token.length > 0
        ? hashOauthProviderToken(returnedRecord.refresh_token)
        : null;
    if (freshRefreshHash) {
      const rows = await lookupRefreshTokens(prisma, clientId, freshRefreshHash);
      for (const row of rows) freshUserIds.add(row.userId);
    }
    const freshAccessHash =
      typeof returnedRecord?.access_token === "string" && returnedRecord.access_token.length > 0
        ? hashOauthProviderToken(returnedRecord.access_token)
        : null;
    if (freshUserIds.size === 0 && freshAccessHash) {
      const atRows = await prisma.oauthAccessToken.findMany({
        where: { clientId, token: freshAccessHash },
        orderBy: { id: "asc" },
        take: ARCHIVE_UNDO_SCAN_PAGE_SIZE,
        select: { userId: true },
      });
      for (const row of atRows) {
        if (row.userId) freshUserIds.add(row.userId);
      }
    }
    for (const userId of freshUserIds) {
      await lockAndRun(userId, async (tx) => {
        const prevFence = await readFamilyFenceState(
          tx,
          userId,
          clientId,
          NULL_FAMILY_FENCE_KEY,
          now,
        );
        if (!prevFence?.active) return;

        // Restrict pre-grant cleanup strictly to the fenced nullable family
        // (never touching concurrent fresh authorization_code exchanges).
        await invalidateOauthRefreshFamilyInTransaction(
          tx,
          userId,
          clientId,
          now,
          prevFence.scopedAuthCodeIds,
          [],
          prevFence.fencedAtMs,
        );

        await writeFamilyFenceState(
          tx,
          userId,
          NULL_FAMILY_FENCE_KEY,
          {
            clientId,
            fenceId: prevFence.fenceId,
            active: false,
            fencedAtMs: prevFence.fencedAtMs,
          },
          now,
        );
      });
    }
    return;
  }

  if (ctx.body.grant_type !== "refresh_token") return;
  if (typeof ctx.body.refresh_token !== "string" || ctx.body.refresh_token.length === 0) return;

  const presentedHash = hashOauthProviderToken(ctx.body.refresh_token);
  const returnedRefreshHash =
    typeof returnedRecord?.refresh_token === "string" && returnedRecord.refresh_token.length > 0
      ? hashOauthProviderToken(returnedRecord.refresh_token)
      : null;
  const returnedAccessHash =
    typeof returnedRecord?.access_token === "string" && returnedRecord.access_token.length > 0
      ? hashOauthProviderToken(returnedRecord.access_token)
      : null;

  const rowsByUser = new Map<string, RefreshTokenIdentityRow[]>();
  const authCodeIdsByUser = new Map<string, Set<string>>();

  const appendRow = (row: RefreshTokenIdentityRow) => {
    const list = rowsByUser.get(row.userId) ?? [];
    list.push(row);
    rowsByUser.set(row.userId, list);
    recordAuthCodeId(authCodeIdsByUser, row.userId, row.authorizationCodeId);
  };

  if (preState) {
    for (const list of preState.rowsByUser.values()) {
      for (const row of list) appendRow(row);
    }
  }
  for (const row of await lookupRefreshTokens(prisma, clientId, presentedHash)) {
    appendRow(row);
  }
  if (returnedRefreshHash) {
    for (const row of await lookupRefreshTokens(prisma, clientId, returnedRefreshHash)) {
      appendRow(row);
    }
  }

  const staleHashes = [presentedHash, ...(returnedRefreshHash ? [returnedRefreshHash] : [])];
  let shouldReject = false;

  for (const [userId, userRows] of rowsByUser) {
    const userCodes = authCodeIdsByUser.get(userId) ?? new Set<string>();
    const pendingKeys: Array<{
      familyKey: string;
      observedFence: FamilyFenceState;
      observedBelongs: boolean;
      hasPreFenceRecord: boolean;
      preFenceId: string | null;
    }> = [];

    for (const familyKey of lookupFamilyFenceKeys(userRows)) {
      const compositeKey = `${userId}\0${familyKey}`;
      const hasPreFenceRecord = preState?.fenceIdByKey.has(compositeKey) ?? false;
      const preFenceId = preState?.fenceIdByKey.get(compositeKey) ?? null;
      const observedFence = await readFamilyFenceState(prisma, userId, clientId, familyKey, now);
      if (!observedFence) continue;

      const observedBelongs = tokenBelongsToFencedFamily(observedFence, userCodes, userRows);
      const clearedAfterBeforeHook =
        !observedFence.active && observedFence.fenceId !== preFenceId && observedBelongs;
      if ((observedFence.active && observedBelongs) || clearedAfterBeforeHook) {
        pendingKeys.push({
          familyKey,
          observedFence,
          observedBelongs,
          hasPreFenceRecord,
          preFenceId,
        });
      }
    }
    if (pendingKeys.length === 0) continue;

    await lockAndRun(userId, async (tx) => {
      for (const {
        familyKey,
        observedFence,
        observedBelongs,
        hasPreFenceRecord,
        preFenceId,
      } of pendingKeys) {
        const currentFence = await readFamilyFenceState(tx, userId, clientId, familyKey, now);
        if (
          currentFence?.active &&
          observedFence.active &&
          currentFence.fenceId === observedFence.fenceId &&
          tokenBelongsToFencedFamily(currentFence, userCodes, userRows)
        ) {
          const fencedCodes = currentFence.scopedAuthCodeIds?.filter(Boolean) ?? [];
          await pruneArchiveUndoCredentials(tx, userId, {
            clientId,
            removeRefreshFamilyForClient: true,
            fencedAtMs: currentFence.fencedAtMs,
            oauthRefreshTokenHashes: staleHashes,
            ...(fencedCodes.length > 0 ? { scopedAuthCodeIds: fencedCodes } : {}),
          });
          await invalidateOauthRefreshFamilyInTransaction(
            tx,
            userId,
            clientId,
            now,
            fencedCodes,
            staleHashes,
            currentFence.fencedAtMs,
          );
          shouldReject = true;
          return;
        }

        if (
          (observedFence.active && observedBelongs) ||
          (currentFence !== null &&
            !currentFence.active &&
            currentFence.fenceId !== preFenceId &&
            tokenBelongsToFencedFamily(currentFence, userCodes, userRows)) ||
          (!hasPreFenceRecord && currentFence !== null && !currentFence.active && observedBelongs)
        ) {
          await pruneArchiveUndoCredentials(tx, userId, {
            clientId,
            oauthRefreshTokenHashes: staleHashes,
          });
          await revokeSpecificRefreshHashesInTransaction(
            tx,
            userId,
            clientId,
            staleHashes,
            returnedAccessHash,
            now,
          );
          shouldReject = true;
          return;
        }
      }
    });
  }

  if (shouldReject) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "Refresh token has been revoked",
    });
  }
}
