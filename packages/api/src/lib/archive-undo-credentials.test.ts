import type { Prisma } from "@cockpit-context/db";
import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/db", () => ({ default: { $transaction: vi.fn() } }));

const { revokeUserCredentialsInTransaction } = await import(
  "@cockpit-context/auth/oauth-revocation"
);
const {
  captureArchiveUndoCredentials,
  clearArchiveUndoRecords,
  pruneArchiveUndoCredentials,
  restoreArchiveUndoCredentials,
  writeArchiveUndoRecord,
} = await import("./archive-undo-credentials");

interface MemToken {
  id: string;
  userId: string;
  revokedAt: Date | null;
}

interface MemGrant {
  id: string;
  userId: string;
  revokedAt: Date | null;
}

interface MemConsent {
  id: string;
  clientId: string;
  userId: string;
  referenceId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface MemRefresh {
  id: string;
  token: string;
  clientId: string;
  sessionId: string | null;
  userId: string;
  referenceId: string | null;
  authorizationCodeId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  expiresAt: Date;
  createdAt: Date;
  revoked: Date | null;
  rotatedAt: Date | null;
  rotationReplayResponse: string | null;
  rotationReplayExpiresAt: Date | null;
  authTime: Date | null;
  confirmation: unknown;
  scopes: string[];
}

interface MemAccess {
  id: string;
  token: string;
  clientId: string;
  sessionId: string | null;
  userId: string;
  referenceId: string | null;
  authorizationCodeId: string | null;
  resources: string[];
  requestedUserInfoClaims: string[];
  refreshId: string | null;
  expiresAt: Date;
  createdAt: Date;
  revoked: Date | null;
  confirmation: unknown;
  scopes: string[];
}

function makeMemoryTx() {
  const state = {
    mcpAgentTokens: [] as MemToken[],
    mcpGrants: [] as MemGrant[],
    oauthClients: [{ clientId: "client-1" }, { clientId: "client-2" }],
    oauthConsents: [] as MemConsent[],
    oauthRefreshTokens: [] as MemRefresh[],
    oauthAccessTokens: [] as MemAccess[],
    verifications: [] as Array<{
      id: string;
      identifier: string;
      value: string;
      expiresAt: Date;
      createdAt: Date;
    }>,
  };

  let seq = 0;

  const tx = {
    $executeRaw: async () => 1,
    session: { deleteMany: async () => ({ count: 0 }) },
    oauthClient: {
      findMany: async ({ where }: { where: { clientId: { in: string[] } } }) =>
        state.oauthClients.filter((c) => where.clientId.in.includes(c.clientId)),
    },
    mcpAgentToken: {
      findMany: async ({ where }: { where: { userId: string; revokedAt: null } }) =>
        state.mcpAgentTokens.filter((r) => r.userId === where.userId && r.revokedAt === null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; id?: { in: string[] }; revokedAt: Date | null };
        data: { revokedAt: Date | null };
      }) => {
        let count = 0;
        for (const r of state.mcpAgentTokens) {
          if (r.userId !== where.userId) continue;
          if (where.id && !where.id.in.includes(r.id)) continue;
          if (where.revokedAt === null) {
            if (r.revokedAt !== null) continue;
          } else if (r.revokedAt?.getTime() !== where.revokedAt.getTime()) {
            continue;
          }
          r.revokedAt = data.revokedAt;
          count += 1;
        }
        return { count };
      },
    },
    mcpGrant: {
      findMany: async ({ where }: { where: { userId: string; revokedAt: null } }) =>
        state.mcpGrants.filter((r) => r.userId === where.userId && r.revokedAt === null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; id?: { in: string[] }; revokedAt: Date | null };
        data: { revokedAt: Date | null };
      }) => {
        let count = 0;
        for (const r of state.mcpGrants) {
          if (r.userId !== where.userId) continue;
          if (where.id && !where.id.in.includes(r.id)) continue;
          if (where.revokedAt === null) {
            if (r.revokedAt !== null) continue;
          } else if (r.revokedAt?.getTime() !== where.revokedAt.getTime()) {
            continue;
          }
          r.revokedAt = data.revokedAt;
          count += 1;
        }
        return { count };
      },
    },
    oauthConsent: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        state.oauthConsents.filter((r) => r.userId === where.userId),
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        const before = state.oauthConsents.length;
        state.oauthConsents = state.oauthConsents.filter((r) => r.userId !== where.userId);
        return { count: before - state.oauthConsents.length };
      },
      createMany: async ({ data }: { data: MemConsent[] }) => {
        for (const item of data) {
          if (!state.oauthConsents.some((existing) => existing.id === item.id)) {
            state.oauthConsents.push({ ...item });
          }
        }
        return { count: data.length };
      },
    },
    oauthRefreshToken: {
      findMany: async ({
        where,
      }: {
        where: { userId: string; revoked: null; expiresAt: { gt: Date } };
      }) =>
        state.oauthRefreshTokens.filter(
          (r) =>
            r.userId === where.userId && r.revoked === null && r.expiresAt > where.expiresAt.gt,
        ),
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        const before = state.oauthRefreshTokens.length;
        state.oauthRefreshTokens = state.oauthRefreshTokens.filter(
          (r) => r.userId !== where.userId,
        );
        return { count: before - state.oauthRefreshTokens.length };
      },
      createMany: async ({ data }: { data: MemRefresh[] }) => {
        for (const item of data) {
          if (!state.oauthRefreshTokens.some((existing) => existing.id === item.id)) {
            state.oauthRefreshTokens.push({ ...item });
          }
        }
        return { count: data.length };
      },
    },
    oauthAccessToken: {
      findMany: async ({
        where,
      }: {
        where: { userId: string; revoked: null; expiresAt: { gt: Date } };
      }) =>
        state.oauthAccessTokens.filter(
          (r) =>
            r.userId === where.userId && r.revoked === null && r.expiresAt > where.expiresAt.gt,
        ),
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        const before = state.oauthAccessTokens.length;
        state.oauthAccessTokens = state.oauthAccessTokens.filter((r) => r.userId !== where.userId);
        return { count: before - state.oauthAccessTokens.length };
      },
      createMany: async ({ data }: { data: MemAccess[] }) => {
        for (const item of data) {
          if (!state.oauthAccessTokens.some((existing) => existing.id === item.id)) {
            state.oauthAccessTokens.push({ ...item });
          }
        }
        return { count: data.length };
      },
    },
    verification: {
      findFirst: async ({ where }: { where: { identifier: string } }) =>
        state.verifications
          .filter((v) => v.identifier === where.identifier)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      create: async ({
        data,
      }: {
        data: { identifier: string; value: string; expiresAt: Date };
      }) => {
        const created = {
          id: `ver-${++seq}`,
          identifier: data.identifier,
          value: data.value,
          expiresAt: data.expiresAt,
          createdAt: new Date(1_700_000_000_000 + seq),
        };
        state.verifications.push(created);
        return created;
      },
      deleteMany: async ({ where }: { where: { identifier: string } }) => {
        const before = state.verifications.length;
        state.verifications = state.verifications.filter((v) => v.identifier !== where.identifier);
        return { count: before - state.verifications.length };
      },
    },
  };

  return { state, tx: tx as unknown as Prisma.TransactionClient };
}

describe("archive undo credential capture & restoration", () => {
  const userId = "user-1";
  const archiveTime = new Date("2026-11-27T12:00:00.000Z");
  const priorRevokedTime = new Date("2026-11-26T00:00:00.000Z");
  const futureExpiry = new Date("2026-12-27T12:00:00.000Z");
  const pastExpiry = new Date("2026-11-26T12:00:00.000Z");

  async function simulateArchive(
    tx: Prisma.TransactionClient,
    state: ReturnType<typeof makeMemoryTx>["state"],
  ) {
    const captured = await captureArchiveUndoCredentials(tx, userId, archiveTime);
    for (const t of state.mcpAgentTokens)
      if (t.userId === userId && t.revokedAt === null) t.revokedAt = archiveTime;
    for (const g of state.mcpGrants)
      if (g.userId === userId && g.revokedAt === null) g.revokedAt = archiveTime;
    state.oauthAccessTokens = state.oauthAccessTokens.filter((a) => a.userId !== userId);
    state.oauthRefreshTokens = state.oauthRefreshTokens.filter((r) => r.userId !== userId);
    state.oauthConsents = state.oauthConsents.filter((c) => c.userId !== userId);
    return writeArchiveUndoRecord(tx, userId, captured, archiveTime);
  }

  it("restores archive-revoked MCP tokens, MCP grants, and live OAuth connections while keeping prior revocations dead", async () => {
    const { state, tx } = makeMemoryTx();
    state.mcpAgentTokens.push(
      { id: "tok-active", userId, revokedAt: null },
      { id: "tok-already-revoked", userId, revokedAt: priorRevokedTime },
      { id: "tok-other-user", userId: "other", revokedAt: null },
    );
    state.mcpGrants.push(
      { id: "grant-active", userId, revokedAt: null },
      { id: "grant-already-revoked", userId, revokedAt: priorRevokedTime },
    );
    state.oauthConsents.push({
      id: "consent-1",
      clientId: "client-1",
      userId,
      referenceId: "ref-1",
      resources: ["https://mcp.example"],
      requestedUserInfoClaims: [],
      scopes: ["openid", "profile"],
      createdAt: priorRevokedTime,
      updatedAt: priorRevokedTime,
    });
    state.oauthRefreshTokens.push(
      {
        id: "ref-live",
        token: "hash-ref-live",
        clientId: "client-1",
        sessionId: "deleted-session-id",
        userId,
        referenceId: "ref-1",
        authorizationCodeId: null,
        resources: ["https://mcp.example"],
        requestedUserInfoClaims: [],
        expiresAt: futureExpiry,
        createdAt: priorRevokedTime,
        revoked: null,
        rotatedAt: null,
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
        authTime: priorRevokedTime,
        confirmation: { jkt: "abc" },
        scopes: ["openid"],
      },
      {
        id: "ref-expired",
        token: "hash-ref-exp",
        clientId: "client-1",
        sessionId: "deleted-session-id",
        userId,
        referenceId: "ref-1",
        authorizationCodeId: null,
        resources: [],
        requestedUserInfoClaims: [],
        expiresAt: pastExpiry,
        createdAt: priorRevokedTime,
        revoked: null,
        rotatedAt: null,
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
        authTime: null,
        confirmation: null,
        scopes: ["openid"],
      },
    );
    state.oauthAccessTokens.push({
      id: "acc-live",
      token: "hash-acc-live",
      clientId: "client-1",
      sessionId: "deleted-session-id",
      userId,
      referenceId: "ref-1",
      authorizationCodeId: null,
      resources: ["https://mcp.example"],
      requestedUserInfoClaims: [],
      refreshId: "ref-live",
      expiresAt: futureExpiry,
      createdAt: priorRevokedTime,
      revoked: null,
      confirmation: null,
      scopes: ["openid"],
    });

    const undoToken = await simulateArchive(tx, state);
    expect(state.mcpAgentTokens.find((t) => t.id === "tok-active")?.revokedAt).toEqual(archiveTime);
    expect(state.mcpGrants.find((g) => g.id === "grant-active")?.revokedAt).toEqual(archiveTime);
    expect(state.oauthConsents).toHaveLength(0);
    expect(state.oauthRefreshTokens).toHaveLength(0);
    expect(state.oauthAccessTokens).toHaveLength(0);

    const restored = await restoreArchiveUndoCredentials(
      tx,
      userId,
      undoToken,
      new Date(archiveTime.getTime() + 10_000),
    );
    expect(restored).toBe(true);
    expect(state.mcpAgentTokens.find((t) => t.id === "tok-active")?.revokedAt).toBeNull();
    expect(state.mcpAgentTokens.find((t) => t.id === "tok-already-revoked")?.revokedAt).toEqual(
      priorRevokedTime,
    );
    expect(state.mcpGrants.find((g) => g.id === "grant-active")?.revokedAt).toBeNull();
    expect(state.mcpGrants.find((g) => g.id === "grant-already-revoked")?.revokedAt).toEqual(
      priorRevokedTime,
    );
    expect(state.oauthConsents.map((c) => c.id)).toEqual(["consent-1"]);
    expect(state.oauthRefreshTokens.map((r) => ({ id: r.id, sessionId: r.sessionId }))).toEqual([
      { id: "ref-live", sessionId: null },
    ]);
    expect(
      state.oauthAccessTokens.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        refreshId: a.refreshId,
      })),
    ).toEqual([{ id: "acc-live", sessionId: null, refreshId: "ref-live" }]);

    // Replaying the consumed one-time token returns false.
    expect(
      await restoreArchiveUndoCredentials(
        tx,
        userId,
        undoToken,
        new Date(archiveTime.getTime() + 15_000),
      ),
    ).toBe(false);
  });

  it("refuses wrong undoToken without consuming the live undo record", async () => {
    const { state, tx } = makeMemoryTx();
    state.mcpAgentTokens.push({ id: "tok-1", userId, revokedAt: null });
    const undoToken = await simulateArchive(tx, state);

    await expect(
      restoreArchiveUndoCredentials(
        tx,
        userId,
        "wrong-token",
        new Date(archiveTime.getTime() + 1000),
      ),
    ).rejects.toBeInstanceOf(ORPCError);

    expect(state.mcpAgentTokens[0]?.revokedAt).toEqual(archiveTime);
    expect(
      await restoreArchiveUndoCredentials(
        tx,
        userId,
        undoToken,
        new Date(archiveTime.getTime() + 2000),
      ),
    ).toBe(true);
    expect(state.mcpAgentTokens[0]?.revokedAt).toBeNull();
  });

  it("does not restore credentials after password-reset revocation or TTL expiry or plain restore", async () => {
    const { state, tx } = makeMemoryTx();
    state.mcpAgentTokens.push({ id: "tok-1", userId, revokedAt: null });
    const undoToken = await simulateArchive(tx, state);

    // Password reset while archived invalidates the pending archive-undo row.
    await revokeUserCredentialsInTransaction(tx, userId, { revokeSessions: true });
    expect(
      await restoreArchiveUndoCredentials(
        tx,
        userId,
        undoToken,
        new Date(archiveTime.getTime() + 5000),
      ),
    ).toBe(false);
    expect(state.mcpAgentTokens[0]?.revokedAt).toEqual(archiveTime);

    // Expired TTL clears the snapshot and restores nothing.
    state.mcpAgentTokens[0]!.revokedAt = null;
    const undoToken2 = await simulateArchive(tx, state);
    expect(
      await restoreArchiveUndoCredentials(
        tx,
        userId,
        undoToken2,
        new Date(archiveTime.getTime() + 10 * 60 * 1000),
      ),
    ).toBe(false);
    expect(state.mcpAgentTokens[0]?.revokedAt).toEqual(archiveTime);

    // Clearing via plain Restore user invalidates any earlier toast Undo.
    state.mcpAgentTokens[0]!.revokedAt = null;
    const undoToken3 = await simulateArchive(tx, state);
    await clearArchiveUndoRecords(tx, userId);
    expect(
      await restoreArchiveUndoCredentials(
        tx,
        userId,
        undoToken3,
        new Date(archiveTime.getTime() + 1000),
      ),
    ).toBe(false);
  });

  it("skips deleted OAuth clients and nulls dangling refreshId references cleanly", async () => {
    const { state, tx } = makeMemoryTx();
    state.oauthClients = [{ clientId: "client-1" }];
    state.oauthConsents.push({
      id: "c-deleted",
      clientId: "deleted-client",
      userId,
      referenceId: null,
      resources: [],
      requestedUserInfoClaims: [],
      scopes: ["openid"],
      createdAt: priorRevokedTime,
      updatedAt: priorRevokedTime,
    });
    state.oauthRefreshTokens.push({
      id: "ref-soon-expired",
      token: "hash-r",
      clientId: "client-1",
      sessionId: null,
      userId,
      referenceId: null,
      authorizationCodeId: null,
      resources: [],
      requestedUserInfoClaims: [],
      expiresAt: new Date(archiveTime.getTime() + 5000),
      createdAt: priorRevokedTime,
      revoked: null,
      rotatedAt: null,
      rotationReplayResponse: null,
      rotationReplayExpiresAt: null,
      authTime: null,
      confirmation: null,
      scopes: ["openid"],
    });
    state.oauthAccessTokens.push({
      id: "acc-longer",
      token: "hash-a",
      clientId: "client-1",
      sessionId: null,
      userId,
      referenceId: null,
      authorizationCodeId: null,
      resources: [],
      requestedUserInfoClaims: [],
      refreshId: "ref-soon-expired",
      expiresAt: futureExpiry,
      createdAt: priorRevokedTime,
      revoked: null,
      confirmation: null,
      scopes: ["openid"],
    });

    const undoToken = await simulateArchive(tx, state);
    const restored = await restoreArchiveUndoCredentials(
      tx,
      userId,
      undoToken,
      new Date(archiveTime.getTime() + 10_000),
    );
    expect(restored).toBe(true);
    expect(state.oauthConsents).toHaveLength(0);
    expect(state.oauthRefreshTokens).toHaveLength(0);
    expect(state.oauthAccessTokens).toHaveLength(1);
    expect(state.oauthAccessTokens[0]?.refreshId).toBeNull();
  });

  it("prunes manually revoked tokens and OAuth grants from a pending archive-undo snapshot", async () => {
    const { state, tx } = makeMemoryTx();
    state.mcpAgentTokens.push(
      { id: "tok-keep", userId, revokedAt: null },
      { id: "tok-revoked-in-flight", userId, revokedAt: null },
    );
    state.mcpGrants.push({ id: "grant-revoked-in-flight", userId, revokedAt: null });
    state.oauthConsents.push({
      id: "consent-revoked",
      clientId: "client-1",
      userId,
      referenceId: "ref-1",
      resources: [],
      requestedUserInfoClaims: [],
      scopes: ["openid"],
      createdAt: priorRevokedTime,
      updatedAt: priorRevokedTime,
    });
    state.oauthAccessTokens.push({
      id: "acc-revoked",
      token: "hash-acc-revoked",
      clientId: "client-1",
      sessionId: null,
      userId,
      referenceId: "ref-1",
      authorizationCodeId: null,
      resources: [],
      requestedUserInfoClaims: [],
      refreshId: null,
      expiresAt: futureExpiry,
      createdAt: priorRevokedTime,
      revoked: null,
      confirmation: null,
      scopes: ["openid"],
    });

    const undoToken = await simulateArchive(tx, state);
    await pruneArchiveUndoCredentials(tx, userId, { mcpTokenId: "tok-revoked-in-flight" });
    await pruneArchiveUndoCredentials(tx, userId, {
      mcpGrantId: "grant-revoked-in-flight",
      clientId: "client-1",
      referenceId: "ref-1",
    });

    const restored = await restoreArchiveUndoCredentials(
      tx,
      userId,
      undoToken,
      new Date(archiveTime.getTime() + 5000),
    );
    expect(restored).toBe(true);
    expect(state.mcpAgentTokens.find((t) => t.id === "tok-keep")?.revokedAt).toBeNull();
    expect(state.mcpAgentTokens.find((t) => t.id === "tok-revoked-in-flight")?.revokedAt).toEqual(
      archiveTime,
    );
    expect(state.mcpGrants.find((g) => g.id === "grant-revoked-in-flight")?.revokedAt).toEqual(
      archiveTime,
    );
    expect(state.oauthConsents).toHaveLength(0);
    expect(state.oauthAccessTokens).toHaveLength(0);
  });
});
