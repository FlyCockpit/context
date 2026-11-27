import type { Prisma } from "@cockpit-context/db";
import { createRouterClient } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prisma>() };
});
vi.mock("@cockpit-context/env/server", async () => {
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  return {
    env: {
      BETTER_AUTH_SECRET: "test-credential-recovery-secret-0123456789",
      ...cockpitContextRateBudgetEnvDefaults(),
    },
    ADMIN_EMAILS: new Set<string>(),
  };
});

const { default: prisma } = await import("@cockpit-context/db");
// Load the pure production verifiers without adding server sources to this
// composite package's TypeScript project (no import-time IO in that module).
const { resolveAgentToken, resolveOauthClaims } = await vi.importActual<{
  resolveAgentToken: (
    token: string,
    options: { prisma: typeof prisma; secret: string; now: Date },
  ) => Promise<{ ok: boolean; reason?: string }>;
  resolveOauthClaims: (
    claims: Record<string, unknown>,
    options: { prisma: typeof prisma; now: Date },
  ) => Promise<{ ok: boolean; reason?: string }>;
}>("../../../../apps/server/src/mcp/credentials");
const { revokeUserCredentials } = await import("@cockpit-context/auth/oauth-revocation");
const { issueMcpGrantClaims } = await import("@cockpit-context/auth/mcp-grant");
const { recordConsentedMcpGrantFlags } = await import("@cockpit-context/auth/mcp-consent-flags");
const { mcpTokensRouter } = await import("./mcp-tokens");
const db = prisma as unknown as {
  $transaction: MockInstance;
  session: { findFirst: MockInstance };
  appSetting: { findMany: MockInstance };
  mcpAgentToken: {
    count: MockInstance;
    create: MockInstance;
    findFirst: MockInstance;
    findUnique: MockInstance;
    updateMany: MockInstance;
  };
  mcpGrant: { createMany: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  oauthClient: { findUnique: MockInstance };
};
const SECRET = "test-credential-recovery-secret-0123456789";
const context = sessionContext({ id: "user-a" });
const session = context.session?.session;
const client = createRouterClient(mcpTokensRouter, { context });
const tokens: Record<string, unknown>[] = [];
const grants: Record<string, unknown>[] = [];
let sessionRow = session;
let beforeCreate = async () => {};
let beforeRevoke = async () => {};
let beforeGrantCreate = async () => {};
let lockTail = Promise.resolve();

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  tokens.length = 0;
  grants.length = 0;
  sessionRow = session;
  lockTail = Promise.resolve();
  beforeCreate = async () => {};
  beforeRevoke = async () => {};
  beforeGrantCreate = async () => {};
  db.appSetting.findMany.mockResolvedValue([]);
  // Each interactive transaction gets its own connection and advisory-lock
  // release. This models blocking, not a mock that merely asserts a SQL call.
  db.$transaction.mockImplementation(
    async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      let unlock = () => {};
      const tx = new Proxy(prisma, {
        get(target, key) {
          if (key === "$executeRaw")
            return async (query: TemplateStringsArray) => {
              // Only the advisory-lock statement acquires a lock. Recovery also
              // executes the two-factor deletion on this same connection.
              if (!query.join("").includes("pg_advisory_xact_lock")) return 1;
              const previous = lockTail;
              const held = deferred();
              lockTail = previous.then(() => held.promise);
              await previous;
              unlock = held.resolve;
              return 1;
            };
          return Reflect.get(target, key);
        },
      });
      try {
        return await run(tx);
      } finally {
        unlock();
      }
    },
  );
  db.session.findFirst.mockImplementation(async ({ where }) =>
    sessionRow &&
    sessionRow.id === where.id &&
    sessionRow.userId === where.userId &&
    sessionRow.expiresAt > where.expiresAt.gt
      ? sessionRow
      : null,
  );
  db.mcpAgentToken.count.mockImplementation(
    async () => tokens.filter((row) => row.revokedAt === null).length,
  );
  db.mcpAgentToken.create.mockImplementation(async ({ data }) => {
    await beforeCreate();
    const row = {
      id: `t${tokens.length}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: new Date(),
      revokedAt: null,
      User: { id: "user-a", banned: false },
      ...data,
    };
    tokens.push(row);
    return row;
  });
  db.mcpAgentToken.findFirst.mockImplementation(async () => tokens[0] ?? null);
  db.mcpAgentToken.findUnique.mockImplementation(
    async ({ where }) => tokens.find((row) => row.lookupPrefix === where.lookupPrefix) ?? null,
  );
  db.mcpAgentToken.updateMany.mockImplementation(async ({ where, data }) => {
    await beforeRevoke();
    const rows = tokens.filter((row) => row.userId === where.userId && row.revokedAt === null);
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  });
  db.mcpGrant.findUnique.mockImplementation(async () => grants[0] ?? null);
  db.mcpGrant.createMany.mockImplementation(async ({ data }) => {
    await beforeGrantCreate();
    if (grants.length) return { count: 0 };
    grants.push({
      id: "g1",
      revokedAt: null,
      lastUsedAt: new Date(),
      allowPropose: true,
      autoApprove: false,
      User: { id: "user-a", banned: false },
      ...data[0],
    });
    return { count: 1 };
  });
  db.mcpGrant.updateMany.mockImplementation(async ({ data }) => {
    for (const row of grants) Object.assign(row, data);
    return { count: grants.length };
  });
  db.oauthClient.findUnique.mockResolvedValue({ name: "Agent" });
});

const authenticate = (token: string) =>
  resolveAgentToken(token, { prisma, secret: SECRET, now: new Date() });
const exchange = () =>
  issueMcpGrantClaims({
    grantType: "authorization_code",
    userId: "user-a",
    sessionId: session?.id,
    clientId: "c",
    referenceId: "r",
    secret: SECRET,
  });
const approve = () =>
  recordConsentedMcpGrantFlags({
    userId: "user-a",
    sessionId: session?.id ?? "",
    clientId: "c",
    referenceId: "r",
    clientName: "Agent",
    flags: { allowPropose: true, autoApprove: false },
  });

describe("credential recovery races", () => {
  it.each(["missing", "foreign", "expired"])(
    "refuses create, regenerate, OAuth consent and code exchange with a %s authoritative session",
    async (kind) => {
      await client.create({ name: "original" });
      if (!session) throw new Error("Missing fixture session");
      sessionRow =
        kind === "missing"
          ? undefined
          : {
              ...session,
              ...(kind === "foreign" ? { userId: "someone-else" } : { expiresAt: new Date(0) }),
            };
      const creates = db.mcpAgentToken.create.mock.calls.length;
      for (const mint of [
        () => client.create({ name: "attacker" }),
        () => client.regenerate({ id: "t0" }),
      ]) {
        await expect(mint()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
      for (const mint of [approve, exchange])
        await expect(mint()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
      expect(db.mcpAgentToken.create).toHaveBeenCalledTimes(creates);
      expect(grants).toHaveLength(0);
    },
  );

  it("issuance winning the lock completes first, then its secret and OAuth claims are rejected by the real verifiers", async () => {
    const claims = await exchange();
    expect(
      (
        await resolveOauthClaims(
          { ...claims, sub: "user-a", client_id: "c" },
          { prisma, now: new Date() },
        )
      ).ok,
    ).toBe(true);
    const admitted = deferred();
    const finishMint = deferred();
    beforeCreate = async () => {
      admitted.resolve();
      await finishMint.promise;
    };
    const mint = client.create({ name: "racing attacker" });
    await admitted.promise;
    sessionRow = undefined; // Better Auth deletes sessions before the after-sweep.
    const sweep = revokeUserCredentials("user-a");
    // A missing issuance lock lets the sweep finish while the insert is parked.
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishMint.resolve();
    const { secret } = await mint;
    await sweep;
    expect(await authenticate(secret)).toMatchObject({ ok: false, reason: "revoked API token" });
    expect(
      await resolveOauthClaims(
        { ...claims, sub: "user-a", client_id: "c" },
        { prisma, now: new Date() },
      ),
    ).toMatchObject({ ok: false });
    await expect(
      issueMcpGrantClaims({
        grantType: "refresh_token",
        userId: "user-a",
        clientId: "c",
        referenceId: "r",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ reason: "tombstone" });
  });

  it.each(["consent", "authorization_code"])(
    "OAuth %s issuance winning the lock is swept before its code can be used",
    async (kind) => {
      const admitted = deferred();
      const finishMint = deferred();
      beforeGrantCreate = async () => {
        admitted.resolve();
        await finishMint.promise;
      };
      const mint = kind === "consent" ? approve() : exchange();
      await admitted.promise;
      sessionRow = undefined;
      const sweep = revokeUserCredentials("user-a");
      await new Promise((resolve) => setTimeout(resolve, 10));
      finishMint.resolve();
      await mint;
      await sweep;
      expect(
        await resolveOauthClaims(
          { sub: "user-a", client_id: "c", mcp_grant_id: "g1" },
          { prisma, now: new Date() },
        ),
      ).toMatchObject({ ok: false });
      await expect(exchange()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    },
  );

  it("a sweep winning the lock makes an admitted cached-session mint wait and then refuse", async () => {
    const sweeping = deferred();
    const finishSweep = deferred();
    beforeRevoke = async () => {
      sweeping.resolve();
      await finishSweep.promise;
    };
    const sweep = revokeUserCredentials("user-a");
    await sweeping.promise;
    // The cached context still passes protectedProcedure; the DB row vanishes
    // while issuance waits for recovery's lock.
    const mint = client.create({ name: "cached attacker" });
    const outcome = mint.then(
      () => ({ allowed: true, error: undefined }),
      (error: unknown) => ({ allowed: false, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    sessionRow = undefined;
    finishSweep.resolve();
    await sweep;
    expect(await outcome).toMatchObject({ allowed: false, error: { code: "UNAUTHORIZED" } });
    expect(tokens).toHaveLength(0);
  });
});
