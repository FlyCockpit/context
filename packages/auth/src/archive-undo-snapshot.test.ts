import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import {
  type ArchiveUndoSnapshot,
  clearArchiveUndoRecords,
  enforceOauthRefreshRevokeFence,
  type OauthRevokePrisma,
  pruneArchiveUndoAfterOauthRevoke,
  pruneArchiveUndoCredentials,
  snapshotOauthRevokeCandidates,
  snapshotOauthTokenRequest,
} from "./archive-undo-snapshot";
import { archiveUndoIdentifier } from "./ban";

const sha256B64Url = (raw: string) => createHash("sha256").update(raw, "utf8").digest("base64url");

function sampleSnapshot(overrides?: Partial<ArchiveUndoSnapshot>): ArchiveUndoSnapshot {
  return {
    version: 1,
    revokedAtMs: 1_700_000_000_000,
    tokenHash: "undo-token-hash",
    mcpAgentTokenIds: ["tok-1"],
    mcpGrantIds: ["grant-1"],
    oauthConsents: [
      {
        id: "consent-1",
        clientId: "client-a",
        referenceId: "ref-1",
        resources: [],
        requestedUserInfoClaims: [],
        scopes: ["mcp"],
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:00.000Z",
      },
    ],
    oauthRefreshTokens: [
      {
        id: "rt-1",
        token: sha256B64Url("raw-refresh-1"),
        clientId: "client-a",
        referenceId: "ref-1",
        authorizationCodeId: null,
        resources: [],
        requestedUserInfoClaims: [],
        expiresAt: "2026-11-28T00:00:00.000Z",
        createdAt: "2026-11-27T00:00:00.000Z",
        rotatedAt: null,
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
        authTime: null,
        confirmation: null,
        scopes: ["mcp", "offline_access"],
      },
      {
        id: "rt-other",
        token: sha256B64Url("raw-refresh-other"),
        clientId: "client-b",
        referenceId: "ref-2",
        authorizationCodeId: null,
        resources: [],
        requestedUserInfoClaims: [],
        expiresAt: "2026-11-28T00:00:00.000Z",
        createdAt: "2026-11-27T00:00:00.000Z",
        rotatedAt: null,
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
        authTime: null,
        confirmation: null,
        scopes: ["mcp", "offline_access"],
      },
    ],
    oauthAccessTokens: [
      {
        id: "at-bound",
        token: sha256B64Url("raw-access-bound"),
        clientId: "client-a",
        referenceId: "ref-1",
        authorizationCodeId: null,
        resources: [],
        requestedUserInfoClaims: [],
        refreshId: "rt-1",
        expiresAt: "2026-11-27T01:00:00.000Z",
        createdAt: "2026-11-27T00:00:00.000Z",
        confirmation: null,
        scopes: ["mcp"],
      },
      {
        id: "at-other",
        token: sha256B64Url("raw-access-other"),
        clientId: "client-b",
        referenceId: "ref-2",
        authorizationCodeId: null,
        resources: [],
        requestedUserInfoClaims: [],
        refreshId: "rt-other",
        expiresAt: "2026-11-27T01:00:00.000Z",
        createdAt: "2026-11-27T00:00:00.000Z",
        confirmation: null,
        scopes: ["mcp"],
      },
    ],
    ...overrides,
  };
}

function isActiveFenceValue(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { active?: boolean }).active === true;
  } catch {
    return false;
  }
}

function makePrisma(overrides: {
  verificationRows?: Array<{ id: string; identifier: string; value: string; expiresAt?: Date }>;
  refreshRows?: Array<{
    id: string;
    userId?: string;
    authorizationCodeId?: string | null;
    revoked?: Date | null;
    rotatedAt?: Date | null;
  }>;
  accessRows?: Array<{ id: string; userId?: string }>;
  fences?: Map<string, string>;
  fenceExpiresAt?: Map<string, Date>;
}) {
  const fences = overrides.fences ?? new Map<string, string>();
  const fenceExpiresAt = overrides.fenceExpiresAt ?? new Map<string, Date>();
  const client: Record<string, unknown> = {
    verification: {
      findMany: vi.fn(async () => overrides.verificationRows ?? []),
      findFirst: vi.fn(
        async (args: { where?: { identifier?: string; expiresAt?: { gt?: Date } } }) => {
          const id = args.where?.identifier;
          if (!id) return null;
          const val = fences.get(id);
          if (val === undefined) return null;
          const exp = fenceExpiresAt.get(id);
          const gt = args.where?.expiresAt?.gt;
          if (exp && gt && exp <= gt) return null;
          return { id: "fence-1", value: val };
        },
      ),
      create: vi.fn(
        async (arg: { data: { identifier: string; value: string; expiresAt?: Date } }) => {
          fences.set(arg.data.identifier, arg.data.value);
          if (arg.data.expiresAt) fenceExpiresAt.set(arg.data.identifier, arg.data.expiresAt);
          return arg.data;
        },
      ),
      deleteMany: vi.fn(async (args: { where?: { identifier?: string } }) => {
        if (args.where?.identifier) {
          fences.delete(args.where.identifier);
          fenceExpiresAt.delete(args.where.identifier);
        }
        return { count: 1 };
      }),
    },
    oauthRefreshToken: {
      findMany: vi.fn(async () => overrides.refreshRows ?? []),
    },
    oauthAccessToken: {
      findMany: vi.fn(async () => overrides.accessRows ?? []),
    },
  };
  client.$transaction = vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client));
  return {
    prisma: client as unknown as OauthRevokePrisma & {
      $transaction: ReturnType<typeof vi.fn>;
      verification: { create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
      oauthRefreshToken: { findMany: ReturnType<typeof vi.fn> };
    },
    fences,
    fenceExpiresAt,
  };
}

function makeTx(
  initialRow: { id: string; identifier: string; value: string; expiresAt: Date } | null,
  options?: {
    refreshRows?: Array<{
      id: string;
      revoked: Date | null;
      rotatedAt: Date | null;
      authorizationCodeId?: string | null;
    }>;
    refreshUpdateCount?: number;
    fences?: Map<string, string>;
    fenceExpiresAt?: Map<string, Date>;
    onRowUpdate?: (row: { identifier: string; value: string }) => void;
  },
) {
  const fences = options?.fences ?? new Map<string, string>();
  const fenceExpiresAt = options?.fenceExpiresAt ?? new Map<string, Date>();
  let snapshotRow = initialRow;
  const deleteMany = vi.fn(async (args?: { where?: { identifier?: string } }) => {
    const id = args?.where?.identifier;
    if (id?.startsWith("oauth-family-revoke-fence:")) {
      fences.delete(id);
      fenceExpiresAt.delete(id);
    } else if (!id || id === snapshotRow?.identifier) {
      snapshotRow = null;
    }
    return { count: 1 };
  });
  const create = vi.fn(
    async (arg: { data: { identifier: string; value: string; expiresAt?: Date } }) => {
      if (arg.data.identifier.startsWith("oauth-family-revoke-fence:")) {
        fences.set(arg.data.identifier, arg.data.value);
        if (arg.data.expiresAt) fenceExpiresAt.set(arg.data.identifier, arg.data.expiresAt);
      } else {
        snapshotRow = {
          id: "ver-next",
          identifier: arg.data.identifier,
          value: arg.data.value,
          expiresAt: arg.data.expiresAt ?? new Date("2026-11-27T00:05:00.000Z"),
        };
        options?.onRowUpdate?.({ identifier: arg.data.identifier, value: arg.data.value });
      }
      return arg.data;
    },
  );
  const findFirst = vi.fn(
    async (args: { where?: { identifier?: string; expiresAt?: { gt?: Date } } }) => {
      const id = args.where?.identifier;
      if (id?.startsWith("oauth-family-revoke-fence:")) {
        const val = fences.get(id);
        if (val === undefined) return null;
        const exp = fenceExpiresAt.get(id);
        const gt = args.where?.expiresAt?.gt;
        if (exp && gt && exp <= gt) return null;
        return { id: "fence-1", value: val };
      }
      return snapshotRow;
    },
  );
  const rtUpdateMany = vi.fn(async () => ({
    count:
      options?.refreshUpdateCount ??
      options?.refreshRows?.filter((r) => r.revoked === null).length ??
      0,
  }));
  const atDeleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    tx: {
      verification: { findFirst, deleteMany, create },
      oauthRefreshToken: {
        findMany: vi.fn(async () => options?.refreshRows ?? []),
        updateMany: rtUpdateMany,
      },
      oauthAccessToken: { deleteMany: atDeleteMany },
    },
    create,
    deleteMany,
    rtUpdateMany,
    atDeleteMany,
  };
}

describe("pruneArchiveUndoAfterOauthRevoke", () => {
  it("prunes the matching OAuth refresh token and removes the family in RepeatRead+fence (Basic auth)", async () => {
    const initial = sampleSnapshot();
    const row = {
      id: "ver-1",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(initial),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const { prisma, fences } = makePrisma({ verificationRows: [row] });
    let savedSnapshotValue = "";
    const { tx, deleteMany } = makeTx(row, {
      fences,
      onRowUpdate: (r) => {
        savedSnapshotValue = r.value;
      },
    });
    const lockAndRun = vi.fn(async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx));
    const ctx = {
      body: { token: "raw-refresh-1", token_type_hint: "refresh_token" },
      headers: new Headers({
        authorization: `Basic ${Buffer.from("client-a:secret-a").toString("base64")}`,
      }),
      context: { returned: null },
    };

    await snapshotOauthRevokeCandidates({ prisma, now: new Date("2026-11-27T00:01:00.000Z"), ctx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: lockAndRun as never,
      now: new Date("2026-11-27T00:01:00.000Z"),
      ctx,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(lockAndRun).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect([...fences.values()].filter(isActiveFenceValue)).toHaveLength(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { identifier: archiveUndoIdentifier("user-1") },
    });
    const saved = JSON.parse(savedSnapshotValue) as ArchiveUndoSnapshot;
    expect(saved.oauthRefreshTokens.map((r) => r.id)).toEqual(["rt-other"]);
    expect(saved.oauthAccessTokens.map((a) => a.id)).toEqual(["at-other"]);
    expect(saved.oauthConsents.map((c) => c.id)).toEqual(["consent-1"]);
    expect(saved.mcpAgentTokenIds).toEqual(["tok-1"]);
  });

  it("supports body client_id, client_assertion sub, Bearer token prefix, and decodeBasicCredentials form encoding", async () => {
    const assertionPayload = Buffer.from(JSON.stringify({ sub: "client-a" })).toString("base64url");
    const assertionJwt = `eyJhbGciOiJFUzI1NiJ9.${assertionPayload}.sig`;

    for (const [clientId, ctx] of [
      [
        "client-a",
        {
          body: { token: "Bearer raw-refresh-1", client_id: "client-a" },
          context: { returned: null },
        },
      ],
      [
        "client-a",
        {
          body: { token: "raw-refresh-1", client_assertion: assertionJwt },
          context: { returned: null },
        },
      ],
      [
        "clientA&ignored=1",
        {
          body: { token: "raw-refresh-1", token_type_hint: "refresh_token" },
          headers: new Headers({
            authorization: `Basic ${Buffer.from("clientA%26ignored%3D1:secret").toString("base64")}`,
          }),
          context: { returned: null },
        },
      ],
    ] as const) {
      const initial = sampleSnapshot();
      const firstRt = initial.oauthRefreshTokens[0];
      if (!firstRt) throw new Error("expected initial refresh token");
      initial.oauthRefreshTokens[0] = { ...firstRt, clientId };
      const row = {
        id: "ver-1",
        identifier: archiveUndoIdentifier("user-1"),
        value: JSON.stringify(initial),
        expiresAt: new Date("2026-11-27T00:05:00.000Z"),
      };
      const { prisma, fences } = makePrisma({ verificationRows: [row] });
      let savedSnapshotValue = "";
      const { tx } = makeTx(row, {
        fences,
        onRowUpdate: (r) => {
          savedSnapshotValue = r.value;
        },
      });

      await pruneArchiveUndoAfterOauthRevoke({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
        now: new Date("2026-11-27T00:01:00.000Z"),
        ctx,
      });
      expect(savedSnapshotValue).not.toBe("");
    }
  });

  it("preserves user identity captured in hooks.before even if provider cleanup deletes the family before hooks.after", async () => {
    const { prisma, fences } = makePrisma({
      verificationRows: [],
      refreshRows: [
        { id: "rt-1", userId: "user-1", rotatedAt: new Date("2026-11-27T00:00:59.000Z") },
      ],
    });
    const ctx = {
      body: { token: "raw-refresh-1", client_id: "client-a", token_type_hint: "refresh_token" },
      context: { returned: null },
    };

    // before-hook observes rotated A before provider invalidateRefreshFamily deletes it
    await snapshotOauthRevokeCandidates({ prisma, now: new Date("2026-11-27T00:01:00.000Z"), ctx });

    // Simulate provider cleanup erasing A before after-hook scans DB
    prisma.oauthRefreshToken.findMany.mockResolvedValue([]);
    const { tx, atDeleteMany, rtUpdateMany } = makeTx(null, { fences });

    const revokeNow = new Date("2026-11-27T00:01:00.000Z");
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
      now: revokeNow,
      ctx,
    });

    expect([...fences.values()].filter(isActiveFenceValue)).toHaveLength(1);
    expect(atDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        refreshId: { not: null },
        OR: [{ authorizationCodeId: null, createdAt: { lte: revokeNow } }],
      },
    });
    expect(rtUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        revoked: null,
        OR: [
          { authorizationCodeId: null, createdAt: { lte: revokeNow } },
          { token: { in: [sha256B64Url("raw-refresh-1")] } },
        ],
      },
      data: { revoked: revokeNow },
    });
  });

  it("fences successor rotations B -> C using family-scoped fence, prunes captured Undo snapshot C, and clears fence on authorization_code", async () => {
    const revokeNow = new Date("2026-11-27T00:01:00.000Z");
    const row = {
      id: "ver-1",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(sampleSnapshot()),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const { prisma, fences } = makePrisma({ verificationRows: [row] });
    const { tx } = makeTx(row, { fences });
    const revokeCtx = {
      body: { token: "raw-refresh-1", client_id: "client-a" },
      context: { returned: null },
    };

    // Revoke A -> publishes active family fence for (user-1, client-a)
    await snapshotOauthRevokeCandidates({ prisma, now: revokeNow, ctx: revokeCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
      now: revokeNow,
      ctx: revokeCtx,
    });
    expect([...fences.values()].filter(isActiveFenceValue)).toHaveLength(1);

    // Concurrent refresh of successor B is blocked in before-hook before creating C
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-b", userId: "user-1", authorizationCodeId: null },
    ]);
    const refreshBCtx = {
      body: { grant_type: "refresh_token", refresh_token: "raw-refresh-b", client_id: "client-a" },
      context: { returned: undefined },
    };
    await expect(
      snapshotOauthTokenRequest({ prisma, now: revokeNow, ctx: refreshBCtx }),
    ).rejects.toThrow(APIError);

    // Even if refresh raced into after-hook producing C and archive captured C in Undo snapshot,
    // enforceOauthRefreshRevokeFence invalidates DB family AND prunes C from the Undo snapshot.
    const baseSnapshot = sampleSnapshot();
    const otherRt = baseSnapshot.oauthRefreshTokens[1];
    if (!otherRt) throw new Error("expected second refresh token");
    const snapshotWithC = sampleSnapshot({
      oauthRefreshTokens: [
        {
          id: "rt-c",
          token: sha256B64Url("raw-refresh-c"),
          clientId: "client-a",
          referenceId: "ref-1",
          authorizationCodeId: null,
          resources: [],
          requestedUserInfoClaims: [],
          expiresAt: "2026-11-28T00:00:00.000Z",
          createdAt: "2026-11-27T00:01:00.000Z",
          rotatedAt: null,
          rotationReplayResponse: null,
          rotationReplayExpiresAt: null,
          authTime: null,
          confirmation: null,
          scopes: ["mcp", "offline_access"],
        },
        otherRt,
      ],
    });
    const archivedCRow = {
      id: "ver-c",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(snapshotWithC),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    let prunedSnapshot = "";
    const raceAfterTx = makeTx(archivedCRow, {
      fences,
      onRowUpdate: (r) => {
        prunedSnapshot = r.value;
      },
    });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(raceAfterTx.tx)) as never,
        now: revokeNow,
        ctx: {
          body: {
            grant_type: "refresh_token",
            refresh_token: "raw-refresh-b",
            client_id: "client-a",
          },
          context: { returned: { access_token: "jwt", refresh_token: "raw-refresh-c" } },
        },
      }),
    ).rejects.toThrow(APIError);
    expect(raceAfterTx.rtUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        revoked: null,
        OR: [
          { authorizationCodeId: null, createdAt: { lte: revokeNow } },
          { token: { in: [sha256B64Url("raw-refresh-b"), sha256B64Url("raw-refresh-c")] } },
        ],
      },
      data: { revoked: revokeNow },
    });
    const parsedPruned = JSON.parse(prunedSnapshot) as ArchiveUndoSnapshot;
    expect(parsedPruned.oauthRefreshTokens.map((r) => r.id)).toEqual(["rt-other"]);

    // Fresh interactive authorization_code issuance deactivates the family fence under lock
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-fresh", userId: "user-1", authorizationCodeId: sha256B64Url("auth-code-1") },
    ]);
    const clearTx = makeTx(null, { fences });
    await enforceOauthRefreshRevokeFence({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(clearTx.tx)) as never,
      now: revokeNow,
      ctx: {
        body: { grant_type: "authorization_code", code: "auth-code-1", client_id: "client-a" },
        context: { returned: { access_token: "jwt-fresh", refresh_token: "raw-refresh-fresh" } },
      },
    });
    expect([...fences.values()].filter(isActiveFenceValue)).toHaveLength(0);
  });

  it("prevents stale refresh enforcement from revoking a fresh authorization_code grant in both lock orderings", async () => {
    const revokeNow = new Date("2026-11-27T00:01:00.000Z");
    const initialRt = sampleSnapshot().oauthRefreshTokens[0];
    if (!initialRt) throw new Error("expected initial refresh token");
    const row = {
      id: "ver-1",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(
        sampleSnapshot({
          oauthRefreshTokens: [{ ...initialRt, authorizationCodeId: "code-revoked" }],
        }),
      ),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const { prisma, fences } = makePrisma({
      verificationRows: [row],
      refreshRows: [
        {
          id: "rt-1",
          userId: "user-1",
          authorizationCodeId: "code-revoked",
          rotatedAt: revokeNow,
        },
      ],
    });
    const { tx: revokeTx } = makeTx(row, { fences });
    const revokeCtx = {
      body: { token: "raw-refresh-1", client_id: "client-a" },
      context: { returned: null },
    };
    await snapshotOauthRevokeCandidates({ prisma, now: revokeNow, ctx: revokeCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(revokeTx)) as never,
      now: revokeNow,
      ctx: revokeCtx,
    });

    // Ordering A: authorization_code clears/advances fence BEFORE stale refresh enters lockAndRun.
    prisma.oauthRefreshToken.findMany.mockImplementation(async (args?: unknown) => {
      const tokenArg = (args as { where?: { token?: string } })?.where?.token;
      if (tokenArg === sha256B64Url("raw-refresh-fresh")) {
        return [
          {
            id: "rt-fresh",
            userId: "user-1",
            authorizationCodeId: sha256B64Url("auth-code-fresh"),
          },
        ];
      }
      return [{ id: "rt-b", userId: "user-1", authorizationCodeId: "code-revoked" }];
    });

    const staleTx = makeTx(null, { fences, refreshRows: [] });
    const authCodeTx = makeTx(null, { fences });
    const raceLock = vi.fn(async (_u: string, fn: (t: unknown) => Promise<void>) => {
      await enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u2: string, fn2: (t2: unknown) => Promise<void>) =>
          fn2(authCodeTx.tx)) as never,
        now: revokeNow,
        ctx: {
          body: {
            grant_type: "authorization_code",
            code: "auth-code-fresh",
            client_id: "client-a",
          },
          context: { returned: { access_token: "jwt-fresh", refresh_token: "raw-refresh-fresh" } },
        },
      });
      await fn(staleTx.tx);
    });

    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: raceLock as never,
        now: revokeNow,
        ctx: {
          body: {
            grant_type: "refresh_token",
            refresh_token: "raw-refresh-b",
            client_id: "client-a",
          },
          context: { returned: { access_token: "jwt-c", refresh_token: "raw-refresh-c" } },
        },
      }),
    ).rejects.toThrow(APIError);

    expect(staleTx.rtUpdateMany).not.toHaveBeenCalledWith({
      where: { userId: "user-1", clientId: "client-a", revoked: null },
      data: { revoked: revokeNow },
    });

    // Ordering B: revoke fence re-published for code-revoked, stale refresh locks BEFORE authorization_code clears.
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(revokeTx)) as never,
      now: revokeNow,
      ctx: revokeCtx,
    });
    const orderingBTx = makeTx(null, { fences });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(orderingBTx.tx)) as never,
        now: revokeNow,
        ctx: {
          body: {
            grant_type: "refresh_token",
            refresh_token: "raw-refresh-b",
            client_id: "client-a",
          },
          context: { returned: { access_token: "jwt-c", refresh_token: "raw-refresh-c" } },
        },
      }),
    ).rejects.toThrow(APIError);

    expect(orderingBTx.rtUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        revoked: null,
        OR: [
          { authorizationCodeId: { in: ["code-revoked"] } },
          { token: { in: [sha256B64Url("raw-refresh-b"), sha256B64Url("raw-refresh-c")] } },
        ],
      },
      data: { revoked: revokeNow },
    });
    expect(orderingBTx.atDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        authorizationCodeId: { in: ["code-revoked"] },
      },
    });
  });

  it("handles nullable authorizationCodeId in Ordering B without blanket cleanup, preserves ordinary logins without advancing inactive fences, and detects replacement fences across expiry", async () => {
    const t0 = new Date("2026-11-27T00:01:00.000Z");
    const row = {
      id: "ver-1",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(sampleSnapshot()),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const { prisma, fences, fenceExpiresAt } = makePrisma({
      verificationRows: [row],
      refreshRows: [{ id: "rt-1", userId: "user-1", authorizationCodeId: null }],
    });
    const { tx } = makeTx(row, { fences, fenceExpiresAt });
    const revokeCtx = {
      body: { token: "raw-refresh-1", client_id: "client-a" },
      context: { returned: null },
    };

    // 1. Null-authorizationCodeId Ordering B: fence active -> stale refresh enters lockAndRun BEFORE
    // authorization_code clears. Invalidation MUST restrict to (authorizationCodeId: null, createdAt <= t0) + stale hashes.
    await snapshotOauthRevokeCandidates({ prisma, now: t0, ctx: revokeCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
      now: t0,
      ctx: revokeCtx,
    });
    const nullOrderingBTx = makeTx(null, { fences, fenceExpiresAt });
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-b", userId: "user-1", authorizationCodeId: null },
    ]);
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(nullOrderingBTx.tx)) as never,
        now: t0,
        ctx: {
          body: {
            grant_type: "refresh_token",
            refresh_token: "raw-refresh-b",
            client_id: "client-a",
          },
          context: { returned: { access_token: "jwt-c", refresh_token: "raw-refresh-c" } },
        },
      }),
    ).rejects.toThrow(APIError);
    expect(nullOrderingBTx.rtUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        revoked: null,
        OR: [
          { authorizationCodeId: null, createdAt: { lte: t0 } },
          { token: { in: [sha256B64Url("raw-refresh-b"), sha256B64Url("raw-refresh-c")] } },
        ],
      },
      data: { revoked: t0 },
    });

    // Clear active fence via fresh login 1 -> inactive fence with fenceId-1
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-fresh-1", userId: "user-1", authorizationCodeId: sha256B64Url("code-fresh-1") },
    ]);
    const clear1Tx = makeTx(null, { fences, fenceExpiresAt });
    await enforceOauthRefreshRevokeFence({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(clear1Tx.tx)) as never,
      now: t0,
      ctx: {
        body: { grant_type: "authorization_code", code: "code-fresh-1", client_id: "client-a" },
        context: { returned: { access_token: "jwt-1", refresh_token: "raw-fresh-1" } },
      },
    });
    const fenceAfterClear1 = [...fences.values()][0];

    // 2. Ordinary second login MUST NOT advance or rewrite already-inactive fence while valid refresh runs concurrently
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-fresh-1", userId: "user-1", authorizationCodeId: sha256B64Url("code-fresh-1") },
    ]);
    const validRefreshCtx = {
      body: { grant_type: "refresh_token", refresh_token: "raw-fresh-1", client_id: "client-a" },
      context: { returned: { access_token: "jwt-2", refresh_token: "raw-fresh-2" } },
    };
    await snapshotOauthTokenRequest({ prisma, now: t0, ctx: validRefreshCtx });

    const clear2Tx = makeTx(null, { fences, fenceExpiresAt });
    await enforceOauthRefreshRevokeFence({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(clear2Tx.tx)) as never,
      now: t0,
      ctx: {
        body: { grant_type: "authorization_code", code: "code-fresh-2", client_id: "client-a" },
        context: { returned: { access_token: "jwt-login2", refresh_token: "raw-login2" } },
      },
    });
    expect([...fences.values()][0]).toBe(fenceAfterClear1);
    expect(clear2Tx.create).not.toHaveBeenCalled();

    // Valid concurrent refresh succeeds cleanly!
    const validRefreshTx = makeTx(null, { fences, fenceExpiresAt });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(validRefreshTx.tx)) as never,
        now: t0,
        ctx: validRefreshCtx,
      }),
    ).resolves.toBeUndefined();
    expect(validRefreshTx.rtUpdateMany).not.toHaveBeenCalled();

    // 3. Expiry cycle reuse prevention: stale refresh captures inactive nullable fenceId-1 before expiry ->
    // fence expires -> new revoke + auth_code cycle produces inactive fenceId-2 -> stale refresh
    // is still rejected via fenceId mismatch (even though generation/expiry restarted),
    // while independent families sharing (user-1, client-a) keep completely isolated fences!
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-null-cycle", userId: "user-1", authorizationCodeId: null },
    ]);
    const staleCrossExpiryCtx = {
      body: { grant_type: "refresh_token", refresh_token: "raw-pre-expiry", client_id: "client-a" },
      context: { returned: { access_token: "jwt-stale", refresh_token: "raw-stale-rot" } },
    };
    await snapshotOauthTokenRequest({ prisma, now: t0, ctx: staleCrossExpiryCtx });

    // Advance past 5-minute fence TTL so fenceId-1 is expired
    const tAfterExpiry = new Date(t0.getTime() + 6 * 60 * 1000);
    await snapshotOauthRevokeCandidates({ prisma, now: tAfterExpiry, ctx: revokeCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
      now: tAfterExpiry,
      ctx: revokeCtx,
    });

    // Clear nullable fence with fresh login -> inactive fenceId-2
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-fresh-nc", userId: "user-1", authorizationCodeId: sha256B64Url("code-new-cycle") },
    ]);
    await enforceOauthRefreshRevokeFence({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(clear1Tx.tx)) as never,
      now: tAfterExpiry,
      ctx: {
        body: { grant_type: "authorization_code", code: "code-new-cycle", client_id: "client-a" },
        context: { returned: { access_token: "jwt-nc", refresh_token: "raw-nc" } },
      },
    });

    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-null-cycle", userId: "user-1", authorizationCodeId: null },
    ]);
    const crossExpiryTx = makeTx(null, { fences, fenceExpiresAt });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(crossExpiryTx.tx)) as never,
        now: tAfterExpiry,
        ctx: staleCrossExpiryCtx,
      }),
    ).rejects.toThrow(APIError);
    expect(crossExpiryTx.rtUpdateMany).not.toHaveBeenCalledWith({
      where: { userId: "user-1", clientId: "client-a", revoked: null },
      data: expect.anything(),
    });
  });

  it("isolates per-family fences so revoking Family B never overwrites Family A, nor blocks Family C", async () => {
    const t0 = new Date("2026-11-27T00:01:00.000Z");
    const { prisma, fences, fenceExpiresAt } = makePrisma({});
    const { tx: revokeATx } = makeTx(null, { fences, fenceExpiresAt });
    const { tx: revokeBTx } = makeTx(null, { fences, fenceExpiresAt });

    // In-flight refresh of Family A completes hooks.before before any revocation
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-a", userId: "user-1", authorizationCodeId: "code-family-a", createdAt: t0 },
    ]);
    const familyACtx = {
      body: { grant_type: "refresh_token", refresh_token: "raw-a", client_id: "client-a" },
      context: { returned: { access_token: "jwt-a2", refresh_token: "raw-a2" } },
    };
    await snapshotOauthTokenRequest({ prisma, now: t0, ctx: familyACtx });

    // Revoke Family A -> publishes Fence A
    const revokeACtx = {
      body: { token: "raw-a0", client_id: "client-a" },
      context: { returned: null },
    };
    await snapshotOauthRevokeCandidates({ prisma, now: t0, ctx: revokeACtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(revokeATx)) as never,
      now: t0,
      ctx: revokeACtx,
    });

    // Revoke independent Family B sharing (user-1, client-a) -> publishes Fence B WITHOUT overwriting Fence A
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-b", userId: "user-1", authorizationCodeId: "code-family-b", createdAt: t0 },
    ]);
    const revokeBCtx = {
      body: { token: "raw-b0", client_id: "client-a" },
      context: { returned: null },
    };
    await snapshotOauthRevokeCandidates({ prisma, now: t0, ctx: revokeBCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(revokeBTx)) as never,
      now: t0,
      ctx: revokeBCtx,
    });
    expect([...fences.values()].filter(isActiveFenceValue)).toHaveLength(2);

    // Independent Family C shares (user-1, client-a) and passes unaffected
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-c", userId: "user-1", authorizationCodeId: "code-family-c", createdAt: t0 },
    ]);
    const familyCCtx = {
      body: { grant_type: "refresh_token", refresh_token: "raw-c", client_id: "client-a" },
      context: { returned: { access_token: "jwt-c2", refresh_token: "raw-c2" } },
    };
    await expect(
      snapshotOauthTokenRequest({ prisma, now: t0, ctx: familyCCtx }),
    ).resolves.toBeUndefined();
    const familyCTx = makeTx(null, { fences, fenceExpiresAt });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(familyCTx.tx)) as never,
        now: t0,
        ctx: familyCCtx,
      }),
    ).resolves.toBeUndefined();
    expect(familyCTx.rtUpdateMany).not.toHaveBeenCalled();

    // In-flight Family A refresh reaches hooks.after: Fence A is STILL intact -> rejected & scoped solely to code-family-a!
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-a", userId: "user-1", authorizationCodeId: "code-family-a", createdAt: t0 },
    ]);
    const enforceATx = makeTx(null, { fences, fenceExpiresAt });
    await expect(
      enforceOauthRefreshRevokeFence({
        prisma,
        lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
          fn(enforceATx.tx)) as never,
        now: t0,
        ctx: familyACtx,
      }),
    ).rejects.toThrow(APIError);
    expect(enforceATx.atDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        authorizationCodeId: { in: ["code-family-a"] },
      },
    });
  });

  it("restricts fence-clearing cleanup to the stale family so concurrent fresh logins never revoke each other, and prunes orphan access tokens sharing a revoked family", async () => {
    const t0 = new Date("2026-11-27T00:01:00.000Z");
    const base = sampleSnapshot();
    const firstRt = base.oauthRefreshTokens[0];
    const firstAt = base.oauthAccessTokens[0];
    const otherAt = base.oauthAccessTokens[1];
    if (!firstRt || !firstAt || !otherAt) throw new Error("expected sample tokens");

    // Captured snapshot has an unexpired access token whose original refresh row
    // ("rt-expired-omitted") was already expired/omitted at archive time, while
    // another captured refresh row ("rt-1") shares `authorizationCodeId: "code-revoked"`.
    const snapshotWithOrphanAccess = sampleSnapshot({
      oauthRefreshTokens: [{ ...firstRt, authorizationCodeId: "code-revoked" }],
      oauthAccessTokens: [
        {
          ...firstAt,
          id: "at-orphan",
          refreshId: "rt-expired-omitted",
          authorizationCodeId: "code-revoked",
        },
        otherAt,
      ],
    });
    const row = {
      id: "ver-orphan",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(snapshotWithOrphanAccess),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const { prisma, fences, fenceExpiresAt } = makePrisma({
      verificationRows: [row],
      refreshRows: [
        { id: "rt-1", userId: "user-1", authorizationCodeId: "code-revoked", rotatedAt: t0 },
      ],
    });
    let savedSnapshot = "";
    const { tx } = makeTx(row, {
      fences,
      fenceExpiresAt,
      onRowUpdate: (r) => {
        savedSnapshot = r.value;
      },
    });
    const revokeCtx = {
      body: { token: "raw-refresh-1", client_id: "client-a" },
      context: { returned: null },
    };

    await snapshotOauthRevokeCandidates({ prisma, now: t0, ctx: revokeCtx });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) => fn(tx)) as never,
      now: t0,
      ctx: revokeCtx,
    });

    // Orphaned access token sharing "code-revoked" MUST be pruned even though rt-expired-omitted was not captured!
    const pruned = JSON.parse(savedSnapshot) as ArchiveUndoSnapshot;
    expect(pruned.oauthRefreshTokens).toEqual([]);
    expect(pruned.oauthAccessTokens.map((a) => a.id)).toEqual(["at-other"]);

    // Concurrent fresh authorization_code exchange #1 leaves the non-null `"code-revoked"` fence
    // untouched and never touches concurrent fresh login #2. Refreshes of `rt-fresh-1` succeed.
    prisma.oauthRefreshToken.findMany.mockResolvedValue([
      { id: "rt-fresh-1", userId: "user-1", authorizationCodeId: sha256B64Url("code-fresh-1") },
    ]);
    const clearTx = makeTx(null, { fences, fenceExpiresAt });
    await enforceOauthRefreshRevokeFence({
      prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(clearTx.tx)) as never,
      now: t0,
      ctx: {
        body: { grant_type: "authorization_code", code: "code-fresh-1", client_id: "client-a" },
        context: { returned: { access_token: "jwt-1", refresh_token: "raw-fresh-1" } },
      },
    });
    expect(clearTx.atDeleteMany).not.toHaveBeenCalled();
    expect(clearTx.rtUpdateMany).not.toHaveBeenCalled();
    await expect(
      snapshotOauthTokenRequest({
        prisma,
        now: t0,
        ctx: {
          body: {
            grant_type: "refresh_token",
            refresh_token: "raw-fresh-1",
            client_id: "client-a",
          },
          context: { returned: undefined },
        },
      }),
    ).resolves.toBeUndefined();

    // Reverse ordering: Undo commits and consumes snapshot (restoring orphan access token with
    // `refreshId: null`) BEFORE pruneArchiveUndoAfterOauthRevoke acquires `lockAndRun`.
    // Live cleanup MUST still delete `authorizationCodeId: { in: ["code-revoked"] }` without `refreshId: { not: null }`.
    const afterUndoPrisma = makePrisma({
      verificationRows: [row],
      refreshRows: [
        { id: "rt-1", userId: "user-1", authorizationCodeId: "code-revoked", rotatedAt: t0 },
      ],
    });
    await snapshotOauthRevokeCandidates({
      prisma: afterUndoPrisma.prisma,
      now: t0,
      ctx: revokeCtx,
    });
    afterUndoPrisma.prisma.verification.findMany.mockResolvedValue([]); // Undo consumed snapshot!
    const afterUndoTx = makeTx(null, { fences: afterUndoPrisma.fences });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma: afterUndoPrisma.prisma,
      lockAndRun: (async (_u: string, fn: (t: unknown) => Promise<void>) =>
        fn(afterUndoTx.tx)) as never,
      now: t0,
      ctx: revokeCtx,
    });
    expect(afterUndoTx.atDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: "client-a",
        authorizationCodeId: { in: ["code-revoked"] },
      },
    });
  });

  it("ignores revocations from another client, errored responses, or mismatched hints", async () => {
    const initial = sampleSnapshot();
    const row = {
      id: "ver-1",
      identifier: archiveUndoIdentifier("user-1"),
      value: JSON.stringify(initial),
      expiresAt: new Date("2026-11-27T00:05:00.000Z"),
    };
    const lockAndRun = vi.fn(async () => {});
    const { prisma } = makePrisma({ verificationRows: [row] });

    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: lockAndRun as never,
      ctx: { body: { token: "raw-refresh-1", client_id: "client-b" }, context: { returned: null } },
    });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: lockAndRun as never,
      ctx: {
        body: { token: "raw-refresh-1", client_id: "client-a", token_type_hint: "access_token" },
        context: { returned: null },
      },
    });
    await pruneArchiveUndoAfterOauthRevoke({
      prisma,
      lockAndRun: lockAndRun as never,
      ctx: {
        body: { token: "raw-refresh-1", client_id: "client-a" },
        context: { returned: new Error("invalid_client") },
      },
    });

    expect(lockAndRun).not.toHaveBeenCalled();
  });

  it("clears malformed snapshots cleanly during direct pruning", async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    await pruneArchiveUndoCredentials(
      {
        verification: {
          findFirst: vi.fn(async () => ({
            id: "v",
            identifier: archiveUndoIdentifier("u"),
            value: "not-json",
            expiresAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
          deleteMany,
          create: vi.fn(),
        },
      },
      "u",
      { mcpTokenId: "tok-1" },
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);

    await clearArchiveUndoRecords({ verification: { deleteMany } }, "u");
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });
});
