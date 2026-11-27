vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The production `auth` instance, built with import IO mocked: this pins its
// wiring (the copies in banned-session-guard.test.ts exercise the behavior).
vi.mock("better-auth/adapters/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/adapters/prisma")>();
  return { ...actual, prismaAdapter: vi.fn(actual.prismaAdapter) };
});
vi.mock("@cockpit-context/db", async () => {
  // Reuse the workspace's mockDeep-backed Prisma fixture without adding a dependency.
  const { createMockContext } = await vi.importActual<{
    createMockContext: () => { db: typeof prisma };
  }>("../../test-utils/src/index");
  return { default: createMockContext().db };
});
vi.mock("@cockpit-context/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    NODE_ENV: "test",
    COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER: 20,
  },
  SIGNUP_ENABLED: true,
  ADMIN_EMAILS: new Set<string>(),
  FORCE_SSO: false,
  SSO_ENABLED: false,
}));
vi.mock("@cockpit-context/mailer", () => ({
  isEmailConfigured: () => true,
  queueEmail: vi.fn(),
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const db = vi.mocked(prisma, { deep: true });
const { oauthRevocationWrites } = await import("./oauth-revocation");
const { prismaAdapter } = await import("better-auth/adapters/prisma");
const { auth, passwordPepper } = await import("./index");
const { createCredentialSetupAdapter } = await import("./credential-setup-adapter");
const { withPasswordWriteLock, isResetPasswordWrite } = await import("./password-write-lock");
const { onUserBanned } = await import("./ban");
const { openLiveStream } = await vi.importActual<{
  openLiveStream: (
    userId: string,
    sessionId: string,
  ) => Promise<{
    signal: AbortSignal;
    assertOpen: () => void;
    untilBanned: <T>(work: Promise<T>) => Promise<T>;
    release: () => void;
  }>;
}>("../../api/src/lib/live-streams");
const { recordResetLinkMailed } = await import("./password-reset-links");

const revocationWrites = () => [
  db.mcpAgentToken.updateMany,
  db.mcpGrant.updateMany,
  db.oauthAccessToken.deleteMany,
  db.oauthRefreshToken.deleteMany,
  db.oauthConsent.deleteMany,
];
let inCredentialTransaction = false;

beforeEach(() => {
  vi.clearAllMocks();
  inCredentialTransaction = false;
  db.$executeRaw.mockReset().mockResolvedValue(1);
  db.verification.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  for (const write of revocationWrites()) write.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (writes: unknown) => {
    if (typeof writes === "function") {
      inCredentialTransaction = true;
      try {
        return await writes(db);
      } finally {
        inCredentialTransaction = false;
      }
    }
    if (Array.isArray(writes)) return Promise.all(writes);
    throw new Error("Expected a transaction");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("production auth wiring", () => {
  it.each(["reset", "quarantine"])(
    "%s closes a stream admitted during the final session sweep before later output",
    async (operation) => {
      let finishSweep = () => {};
      let sweepEntered = () => {};
      const entered = new Promise<void>((resolve) => {
        sweepEntered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        finishSweep = resolve;
      });
      const user = {
        id: "u-gap",
        createdAt: new Date(),
        updatedAt: new Date(),
        name: "Gap",
        email: "gap@example.test",
        emailVerified: true,
        image: null,
        role: "user",
        locale: "en-US",
        banned: false,
        banReason: null,
        banExpires: null,
        twoFactorEnabled: false,
        operationalAlerts: true,
      };
      const session = {
        id: "gap-session",
        userId: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        token: "gap-token",
        ipAddress: null,
        userAgent: null,
        impersonatedBy: null,
      };
      db.user.findUnique.mockResolvedValue(user);
      db.session.findFirst.mockResolvedValue(session);
      (db.session.deleteMany as MockInstance).mockImplementation(async () => {
        sweepEntered();
        await held;
        db.session.findFirst.mockResolvedValue(null);
        return { count: 1 };
      });
      db.account.updateMany.mockResolvedValue({ count: 1 });
      const reset = auth.options.emailAndPassword?.onPasswordReset;
      if (!reset) throw new Error("Missing password reset hook");
      const recovery =
        operation === "reset"
          ? reset({ user })
          : (await import("./credential-revocation")).quarantineUntrustedPasswordWrite("u-gap", {
              hash: async () => "unusable-peppered-hash",
            });
      await entered;
      const stream = await openLiveStream("u-gap", "gap-session");
      try {
        expect(stream.signal.aborted).toBe(false);
        finishSweep();
        await recovery;
        expect(stream.signal.aborted).toBe(true);
        expect(() => stream.assertOpen()).toThrow();
        // A pending snapshot/output is refused as well as buffered yields.
        await expect(stream.untilBanned(new Promise(() => {}))).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
        await expect(openLiveStream("u-gap", "gap-session")).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      } finally {
        finishSweep();
        stream.release();
      }
    },
  );
  it("uses the pepper for hashing and verifying passwords", () => {
    expect(auth.options.emailAndPassword?.password?.hash).toBe(passwordPepper.hash);
    expect(auth.options.emailAndPassword?.password?.verify).toBe(passwordPepper.verify);
  });

  it("revokes every session on password reset and keeps the 60-second cookie cache", () => {
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(auth.options.session?.cookieCache).toEqual({ enabled: true, maxAge: 60 });
    // Direct transactional session deletion relies on there being no second
    // authoritative store whose entries could outlive the database rows.
    expect(auth.options).not.toHaveProperty("secondaryStorage");
  });
  it("registers the banned-session guard as the first plugin", () => {
    expect(auth.options.plugins?.[0]?.id).toBe("cockpit-context-banned-session-guard");
  });

  it("announces a ban written through Better-Auth's user update, and tolerates a vanished row", async () => {
    const after = auth.options.databaseHooks?.user?.update?.after;
    expect(after).toBeTypeOf("function");
    const announced: string[] = [];
    const stop = onUserBanned((userId) => announced.push(userId));
    try {
      const call = after as unknown as (user: unknown, ctx: unknown) => Promise<void>;
      await call({ id: "u-ok", banned: false }, null);
      await call({ id: "u-banned", banned: true, banExpires: null }, null);
      await expect(call(null, null)).resolves.toBeUndefined();
    } finally {
      stop();
    }
    expect(announced).toEqual(["u-banned"]);
  });
});

it("announces reset recovery once after its final sweep", async () => {
  const announced = vi.fn();
  const stop = onUserBanned(announced);
  try {
    await auth.options.emailAndPassword!.onPasswordReset!({ user: { id: "u" } as never });
    expect(announced).toHaveBeenCalledExactlyOnceWith("u", "session-revocation");
  } finally {
    stop();
  }
});

function headersOf(headers: Headers) {
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; "),
  });
}

/** Auth adapter IO stays in memory; direct credential writes use the Prisma mock above. */
async function resetFixture(onResetHash: () => void | Promise<void> = () => {}) {
  const memory: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  type Row = Record<string, unknown>;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, wanted]) => {
      if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
        const condition = wanted as Row;
        if ("startsWith" in condition && !String(row[key]).startsWith(String(condition.startsWith)))
          return false;
        if ("not" in condition && row[key] === condition.not) return false;
        if (
          "gt" in condition &&
          !(row[key] instanceof Date && condition.gt instanceof Date && row[key] > condition.gt)
        )
          return false;
        return true;
      }
      return row[key] === wanted;
    });
  for (const [name, delegate] of [
    ["verification", db.verification],
    ["user", db.user],
    ["account", db.account],
  ] as const) {
    (delegate.findFirst as MockInstance).mockImplementation(
      async ({ where } = {}) => memory[name]?.find((row) => matches(row, where)) ?? null,
    );
    (delegate.findUnique as MockInstance).mockImplementation(async ({ where }) => {
      const row = memory[name]?.find((row) => matches(row, where));
      if (!row || name !== "user") return row ?? null;
      return {
        ...row,
        accounts: memory.account?.filter((account) => account.userId === row.id).slice(0, 2) ?? [],
        sessions:
          memory.session
            ?.filter(
              (session) =>
                session.userId === row.id &&
                session.expiresAt instanceof Date &&
                session.expiresAt > new Date(),
            )
            .slice(0, 1) ?? [],
      };
    });
    (delegate.create as MockInstance).mockImplementation(async ({ data }) => {
      const row = { id: crypto.randomUUID(), ...data };
      memory[name]!.push(row);
      return row;
    });
    (delegate.updateMany as MockInstance).mockImplementation(async ({ where, data }) => {
      const rows = memory[name]?.filter((row) => matches(row, where)) ?? [];
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    });
  }
  // Every bound adapter sees the same tables; transaction failures restore them.
  vi.mocked(prismaAdapter).mockImplementation(() => memoryAdapter(memory));
  db.$transaction.mockImplementation(async (work: unknown, options?: { timeout?: number }) => {
    if (Array.isArray(work)) return Promise.all(work);
    if (typeof work !== "function") throw new Error("Expected transaction callback");
    const prior = inCredentialTransaction;
    const snapshot = structuredClone(memory);
    inCredentialTransaction = true;
    try {
      return await work(db);
    } catch (error) {
      if (!options?.timeout) Object.assign(memory, snapshot);
      throw error;
    } finally {
      inCredentialTransaction = prior;
    }
  });
  const sendOTP = vi.fn(async (_data: { user: { id: string }; otp: string }) => {});
  const productionTwoFactor = auth.options.plugins?.find((plugin) => plugin.id === "two-factor");
  if (!productionTwoFactor) throw new Error("Missing production two-factor plugin");
  const current = betterAuth({
    secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    baseURL: "http://localhost:3000",
    database: createCredentialSetupAdapter({ emailConfigured: true }),
    logger: { disabled: true },
    rateLimit: { enabled: false },
    session: auth.options.session,
    hooks: auth.options.hooks,
    plugins: [
      twoFactor({
        ...productionTwoFactor.options,
        otpOptions: { storeOTP: "hashed", sendOTP },
      }),
    ],
    emailAndPassword: {
      ...auth.options.emailAndPassword,
      enabled: true,
      // Set up signed-in accounts; the production reset hooks still enforce SMTP rules.
      requireEmailVerification: false,
      password: {
        hash: async (password: string) => {
          if (password === "replacement-password-456") await onResetHash();
          return createHash("sha256").update(password).digest("hex");
        },
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === createHash("sha256").update(password).digest("hex"),
      },
    },
  });
  const password = "original-password-123";
  const first = await current.api.signUpEmail({
    body: { email: "reset@example.com", password, name: "Reset" },
    returnHeaders: true,
  });
  const second = await current.api.signInEmail({
    body: { email: "reset@example.com", password },
    returnHeaders: true,
  });
  const other = await current.api.signUpEmail({
    body: { email: "other@example.com", password, name: "Other" },
    returnHeaders: true,
  });
  // Better Auth uses the memory adapter; direct Prisma session operations must
  // see the same authoritative rows as the production reset and mint paths.
  (db.$executeRaw as MockInstance).mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(inCredentialTransaction).toBe(true);
      const sql = strings.join("?");
      if (sql.includes("pg_advisory_xact_lock")) return 1;
      // This set-based deletion uses portable SQL: execute the actual statement
      // in SQLite memory rather than duplicating its predicates in a mock.
      const verificationDb = new DatabaseSync(":memory:");
      try {
        verificationDb.exec("CREATE TABLE verification (id TEXT, identifier TEXT, value TEXT)");
        const insert = verificationDb.prepare("INSERT INTO verification VALUES (?, ?, ?)");
        for (const row of memory.verification ?? []) {
          if (
            typeof row.id !== "string" ||
            typeof row.identifier !== "string" ||
            typeof row.value !== "string"
          )
            throw new Error("Invalid verification fixture row");
          insert.run(row.id, row.identifier, row.value);
        }
        const bindings = values.map((value) => {
          if (typeof value !== "string") throw new Error("Expected a bound user ID");
          return value;
        });
        const result = verificationDb.prepare(sql).run(...bindings);
        const survivingIds = new Set(
          verificationDb
            .prepare("SELECT id FROM verification")
            .all()
            .map((row) => row.id),
        );
        memory.verification =
          memory.verification?.filter(
            (row) => typeof row.id === "string" && survivingIds.has(row.id),
          ) ?? [];
        return Number(result.changes);
      } finally {
        verificationDb.close();
      }
    },
  );
  (db.session.deleteMany as MockInstance).mockImplementation(async ({ where } = {}) => {
    expect(inCredentialTransaction).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalled();
    const before = memory.session ?? [];
    const remaining = before.filter(
      (row) => row.userId !== where?.userId || (where?.token?.not && row.token === where.token.not),
    );
    memory.session = remaining;
    return { count: before.length - remaining.length };
  });
  (db.session.findFirst as MockInstance).mockImplementation(
    async ({ where }) =>
      memory.session?.find(
        (row) =>
          row.id === where.id &&
          row.userId === where.userId &&
          row.expiresAt instanceof Date &&
          row.expiresAt > where.expiresAt.gt,
      ) ?? null,
  );
  const cookies = [headersOf(first.headers), headersOf(second.headers)];
  const context = await current.$context;
  (db.verification.deleteMany as MockInstance).mockImplementation(
    async ({
      where,
    }: {
      where: { value?: string; identifier?: string | { startsWith: string } };
    }) => {
      const before = memory.verification ?? [];
      memory.verification = before.filter((row) => !matches(row, where));
      return { count: before.length - memory.verification.length };
    },
  );
  const userId = memory.user?.find((row) => row.email === "reset@example.com")?.id;
  const otherUserId = memory.user?.find((row) => row.email === "other@example.com")?.id;
  if (typeof userId !== "string" || typeof otherUserId !== "string")
    throw new Error("Missing fixture users");
  await context.internalAdapter.createVerificationValue({
    identifier: "reset-password:reset-token",
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await recordResetLinkMailed({
    userId,
    token: "reset-token",
    email: "reset@example.com",
  });
  const rawReset = current.api.resetPassword.bind(current.api);
  const rawHandler = current.handler.bind(current);
  const requestFor = (token: string) =>
    new Request("http://localhost:3000/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  const resetWithLock = (async (input: Parameters<typeof rawReset>[0]) => {
    if (isResetPasswordWrite()) return rawReset(input);
    let result: unknown;
    await withPasswordWriteLock(
      "/reset-password",
      requestFor(input?.body.token ?? ""),
      async () => {
        result = await rawReset(input);
        return new Response("ok");
      },
      { getSession: async () => null },
    );
    return result;
  }) as typeof current.api.resetPassword;
  vi.spyOn(current.api, "resetPassword").mockImplementation(resetWithLock);
  current.handler = (request) =>
    !isResetPasswordWrite() && new URL(request.url).pathname.endsWith("/reset-password")
      ? withPasswordWriteLock("/reset-password", request, () => rawHandler(request), {
          getSession: async () => null,
        })
      : rawHandler(request);
  // Setup operations are not part of the recovery assertions below.
  vi.clearAllMocks();
  return {
    current,
    memory,
    sendOTP,
    cookies,
    userId,
    other: { headers: headersOf(other.headers), userId: otherUserId },
    reset: () =>
      current.api.resetPassword({
        body: { token: "reset-token", newPassword: "replacement-password-456" },
      }),
  };
}

function expectCredentialRevocation(userId: string) {
  const now = db.mcpAgentToken.updateMany.mock.calls[0]?.[0]?.data.revokedAt;
  expect(now).toBeInstanceOf(Date);
  expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  for (const write of [
    db.oauthAccessToken.deleteMany,
    db.oauthRefreshToken.deleteMany,
    db.oauthConsent.deleteMany,
  ]) {
    expect(write).toHaveBeenCalledWith({ where: { userId } });
  }
  expect(db.$transaction).toHaveBeenCalledTimes(5);
}

describe("password reset revocation", { timeout: 30_000 }, () => {
  it("refuses setPassword for an existing SSO user without a password-write lock", async () => {
    const fixture = await resetFixture();
    fixture.memory.account =
      fixture.memory.account?.filter((row) => row.userId !== fixture.userId) ?? [];
    fixture.memory.account.push({
      id: "sso-account",
      userId: fixture.userId,
      accountId: "sso",
      providerId: "sso",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const instance = betterAuth({
      secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
      baseURL: "http://localhost:3000",
      database: memoryAdapter(fixture.memory),
      logger: { disabled: true },
      rateLimit: { enabled: false },
      emailAndPassword: { enabled: true },
      databaseHooks: { account: auth.options.databaseHooks?.account },
    });
    await expect(
      instance.api.setPassword({
        headers: fixture.cookies[0],
        body: { newPassword: "a-new-sso-password-123" },
      }),
    ).rejects.toThrow(/password-write lock/);
    expect(
      fixture.memory.account?.filter(
        (row) => row.userId === fixture.userId && row.providerId === "credential",
      ),
    ).toHaveLength(0);
  });

  it("preserves forbidden admin impersonation/password-setting and the banned-session answer", async () => {
    const fixture = await resetFixture();
    const { admin } = await import("better-auth/plugins");
    const { adminPluginAccess } = await import("./admin-access");
    const { bannedSessionGuard } = await import("./banned-session-guard");
    const instance = betterAuth({
      secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
      baseURL: "http://localhost:3000",
      database: memoryAdapter(fixture.memory),
      logger: { disabled: true },
      rateLimit: { enabled: false },
      plugins: [bannedSessionGuard(), admin({ defaultRole: "user", ...adminPluginAccess })],
      databaseHooks: {
        account: auth.options.databaseHooks?.account,
        session: auth.options.databaseHooks?.session,
      },
    });
    const actor = fixture.memory.user?.find((row) => row.id === fixture.userId);
    if (!actor) throw new Error("Missing admin");
    actor.role = "admin";
    const sessionsBefore = structuredClone(fixture.memory.session);
    const accountsBefore = structuredClone(fixture.memory.account);
    const call = (path: string) =>
      instance.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
            cookie: fixture.cookies[0]?.get("cookie") ?? "",
          },
          body: JSON.stringify({
            userId: fixture.other.userId,
            newPassword: "attempted-admin-password",
          }),
        }),
      );
    for (const path of ["/admin/impersonate-user", "/admin/set-user-password"])
      expect((await call(path)).status).toBe(403);
    expect(fixture.memory.session).toEqual(sessionsBefore);
    actor.banned = true;
    actor.banExpires = null;
    for (const path of ["/admin/impersonate-user", "/admin/set-user-password"])
      expect((await call(path)).status).toBe(401);
    expect(fixture.memory.session?.filter((row) => row.userId === fixture.userId)).toHaveLength(0);
    expect(
      fixture.memory.session?.filter((row) => row.userId === fixture.other.userId),
    ).toHaveLength(1);
    expect(fixture.memory.account).toEqual(accountsBefore);
  });

  it("announces completed reset once while inside the password-write lock", async () => {
    const fixture = await resetFixture();
    const { handlePasswordAuthRequest } = await import("./password-auth-handler");
    const { passwordWriteLockHeld } = await import("./password-write-lock");
    (db.verification.findFirst as MockInstance).mockImplementation(
      async ({ where }: { where: { identifier: string } }) =>
        fixture.memory.verification?.find((row) => row.identifier === where.identifier) ?? null,
    );
    db.$queryRaw.mockResolvedValue([{ locked: true }]);
    const announced = vi.fn(() => {
      expect(passwordWriteLockHeld()).toBe(true);
    });
    const stop = onUserBanned(announced);
    try {
      const response = await handlePasswordAuthRequest(
        fixture.current,
        new Request("http://localhost:3000/api/auth/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ token: "reset-token", newPassword: "replacement-password-456" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(announced).toHaveBeenCalledExactlyOnceWith(fixture.userId, "session-revocation");
    } finally {
      stop();
    }
  });

  it.each(["pre-sweep", "post-sweep"])(
    "the %s deletes real plugin challenges, OTPs, attempt counters and trusted devices",
    async (sweep) => {
      type Challenge = { headers: Headers; code: string; identifier: string };
      let pending: Challenge;
      let ownedIds: unknown[] = [];
      const fixture = await resetFixture(async () => {
        if (sweep === "post-sweep") await preparePending();
        else {
          expect(fixture.memory.verification?.some((row) => ownedIds.includes(row.id))).toBe(false);
          await expect(complete(pending)).rejects.toMatchObject({
            body: { code: "INVALID_TWO_FACTOR_COOKIE" },
          });
        }
      });
      const { current, memory, cookies, userId, other, sendOTP } = fixture;
      await current.api.enableTwoFactor({
        headers: cookies[0],
        body: { password: "original-password-123", method: "otp" },
      });
      await current.api.enableTwoFactor({
        headers: other.headers,
        body: { password: "original-password-123", method: "otp" },
      });
      const challenge = async (email: string): Promise<Challenge> => {
        const result = await current.api.signInEmail({
          body: { email, password: "original-password-123" },
          returnHeaders: true,
        });
        expect(result.response).toMatchObject({ twoFactorRedirect: true });
        const headers = headersOf(result.headers);
        await current.api.sendTwoFactorOTP({ headers });
        const delivered = sendOTP.mock.lastCall?.[0];
        if (!delivered) throw new Error("Missing delivered OTP");
        const record = memory.verification?.findLast(
          (row) =>
            row.value === delivered.user.id &&
            typeof row.identifier === "string" &&
            /^2fa-[\w-]{20}$/.test(row.identifier),
        );
        if (typeof record?.identifier !== "string") throw new Error("Missing challenge");
        return { headers, code: delivered.otp, identifier: record.identifier };
      };
      const complete = (value: Challenge) =>
        current.api.verifyTwoFactorOTP({
          headers: value.headers,
          body: { code: value.code, trustDevice: true },
        });
      const preparePending = async () => {
        // Real verification creates a trust-device record, then leave two old-password
        // logins pending. OTP values are hashes plus counters, never user IDs.
        await complete(await challenge("reset@example.com"));
        const beforePending = new Set(memory.verification?.map((row) => row.id));
        const trustedIds = (memory.verification ?? [])
          .filter(
            (row) =>
              row.value === userId &&
              typeof row.identifier === "string" &&
              row.identifier.startsWith("trust-device-"),
          )
          .map((row) => row.id);
        pending = await challenge("reset@example.com");
        await challenge("reset@example.com");
        const identifiers = [
          pending.identifier,
          `2fa-otp-${pending.identifier}`,
          `2fa-attempts-${pending.identifier}`,
        ];
        for (const identifier of identifiers)
          expect(memory.verification?.some((row) => row.identifier === identifier)).toBe(true);
        expect(
          memory.verification?.some(
            (row) =>
              row.value === userId &&
              typeof row.identifier === "string" &&
              row.identifier.startsWith("trust-device-"),
          ),
        ).toBe(true);
        ownedIds = [
          ...trustedIds,
          ...(memory.verification ?? [])
            .filter((row) => !beforePending.has(row.id))
            .map((row) => row.id),
        ];
        expect(ownedIds).toHaveLength(7);
      };
      await complete(await challenge("other@example.com"));
      const otherPending = await challenge("other@example.com");
      const otherRows = structuredClone(
        (memory.verification ?? []).filter(
          (row) =>
            typeof row.identifier === "string" &&
            (row.identifier.startsWith("2fa-") || row.identifier.startsWith("trust-device-")),
        ),
      );
      const context = await current.$context;
      await context.internalAdapter.createVerificationValue({
        identifier: "unrelated-verification",
        value: userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      if (sweep === "pre-sweep") await preparePending();
      await fixture.reset();
      expect(memory.verification?.some((row) => ownedIds.includes(row.id))).toBe(false);
      await expect(complete(pending!)).rejects.toMatchObject({
        body: { code: "INVALID_TWO_FACTOR_COOKIE" },
      });
      expect(
        await context.internalAdapter.findVerificationValue("unrelated-verification"),
      ).not.toBeNull();
      expect(
        memory.verification?.filter((row) => otherRows.some((otherRow) => otherRow.id === row.id)),
      ).toEqual(otherRows);
      await expect(complete(otherPending)).resolves.toMatchObject({ user: { id: other.userId } });
      expect(memory.session?.filter((row) => row.userId === userId)).toHaveLength(0);
    },
  );

  it.each(["revoked", "expired"])("blocks a %s session's cache renewal chain", async (state) => {
    const start = new Date("2026-11-26T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const { current, cookies, memory, userId, reset } = await resetFixture();
    const update = (headers: Headers) =>
      current.handler(
        new Request("http://localhost:3000/api/auth/update-user", {
          method: "POST",
          headers: {
            cookie: headers.get("cookie") ?? "",
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Renewed" }),
        }),
      );
    // Control: the real pinned endpoint renews a live session's cache.
    vi.setSystemTime(new Date(start.getTime() + 10_000));
    const live = await update(cookies[0]!);
    expect(live.status).toBe(200);
    expect(live.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringMatching(/session_data=.+;.*Max-Age=60/i)]),
    );
    if (state === "revoked") await reset();
    else
      for (const row of memory.session ?? []) {
        if (row.userId === userId) row.expiresAt = new Date(start.getTime() + 20_000);
      }
    vi.setSystemTime(new Date(start.getTime() + 45_000));
    expect(await current.api.getSession({ headers: cookies[0] })).toMatchObject({
      user: { id: userId },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await update(cookies[0]!);
      expect(response.status).toBe(401);
      const cleared = response.headers.getSetCookie();
      for (const name of ["session_token", "session_data"]) {
        expect(cleared).toEqual(
          expect.arrayContaining([expect.stringMatching(new RegExp(`${name}=;.*Max-Age=0`, "i"))]),
        );
      }
      expect(cleared.some((cookie) => /session_data=[^;]+;/.test(cookie))).toBe(false);
    }
    vi.setSystemTime(new Date(start.getTime() + 60_001));
    expect(await current.api.getSession({ headers: cookies[0] })).toBeNull();
  });

  it("fails closed on an authoritative session lookup error before renewing cookies or writing", async () => {
    const { current, cookies, memory, userId } = await resetFixture();
    const context = await current.$context;
    const before = structuredClone(memory.user?.find((row) => row.id === userId));
    vi.spyOn(context.internalAdapter, "findSession").mockRejectedValueOnce(
      new Error("DB unavailable"),
    );
    const response = await current.handler(
      new Request("http://localhost:3000/api/auth/update-user", {
        method: "POST",
        headers: {
          cookie: cookies[0]?.get("cookie") ?? "",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Attacker" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(memory.user?.find((row) => row.id === userId)).toEqual(before);
  });

  it("does not let stale cookies block anonymous sign-in or sign-out", async () => {
    const { current, cookies, reset } = await resetFixture();
    await reset();
    for (const [path, body] of [
      ["sign-in/email", { email: "reset@example.com", password: "replacement-password-456" }],
      ["sign-out", {}],
    ] as const) {
      const response = await current.handler(
        new Request(`http://localhost:3000/api/auth/${path}`, {
          method: "POST",
          headers: {
            cookie: cookies[0]?.get("cookie") ?? "",
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
    }
  });

  it.each(["verified", "SSO", "session"])(
    "refuses a shown link for an account activated by %s before revoking anything",
    async (activation) => {
      const { current, reset, memory, userId } = await resetFixture();
      const context = await current.$context;
      memory.verification =
        memory.verification?.filter(
          (row) => !String(row.identifier).startsWith("reset-password-mailed:"),
        ) ?? [];
      if (activation !== "session")
        memory.session = memory.session?.filter((row) => row.userId !== userId) ?? [];
      if (activation === "verified")
        await context.internalAdapter.updateUser(userId, { emailVerified: true });
      if (activation === "SSO")
        await context.internalAdapter.linkAccount({
          userId,
          providerId: "sso",
          accountId: "idp-1",
        });
      const before = structuredClone(memory);
      vi.clearAllMocks();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(reset()).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
      }
      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
      expect(memory.account).toEqual(before.account);
      expect(memory.user).toEqual(before.user);
    },
  );

  it("finalizes a committed reset before returning a post-sweep error over HTTP", async () => {
    const { current, userId } = await resetFixture();
    const context = await current.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:other-link",
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.mcpAgentToken.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValue(new Error("post-sweep unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await current.handler(
      new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ token: "reset-token", newPassword: "replacement-password-456" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await context.internalAdapter.findUserById(userId)).toMatchObject({
      emailVerified: true,
    });
    expect(
      await context.internalAdapter.findVerificationValue("reset-password:other-link"),
    ).toBeNull();
    db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each(["mailed", "shown", "changed address"])(
    "finalizes a %s link and kills other reset links before reporting post-sweep failure",
    async (delivery) => {
      const { current, reset, userId, other, memory } = await resetFixture();
      const context = await current.$context;
      if (delivery === "shown") {
        memory.verification =
          memory.verification?.filter(
            (row) => !String(row.identifier).startsWith("reset-password-mailed:"),
          ) ?? [];
        memory.session = memory.session?.filter((row) => row.userId !== userId) ?? [];
      } else if (delivery === "changed address") {
        await context.internalAdapter.updateUser(userId, { email: "changed@example.com" });
      }
      await context.internalAdapter.createVerificationValue({
        identifier: "reset-password:other-link",
        value: userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await context.internalAdapter.createVerificationValue({
        identifier: "unrelated-verification",
        value: userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await context.internalAdapter.createVerificationValue({
        identifier: "reset-password:other-user-link",
        value: other.userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const failure = new RangeError("post-sweep unavailable");
      db.mcpAgentToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValue(failure);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(reset()).rejects.toBe(failure);
      expect(await context.internalAdapter.findUserById(userId)).toMatchObject({
        emailVerified: delivery === "mailed",
      });
      expect(
        memory.verification?.some((row) =>
          String(row.identifier).startsWith("reset-password-mailed:"),
        ),
      ).toBe(delivery === "changed address");
      await expect(
        current.api.signInEmail({
          body: {
            email: delivery === "changed address" ? "changed@example.com" : "reset@example.com",
            password: "replacement-password-456",
          },
        }),
      ).resolves.toBeDefined();
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: {
          identifier: { startsWith: "reset-password:", not: "reset-password:reset-token" },
          value: userId,
        },
      });
      expect(
        await context.internalAdapter.findVerificationValue("reset-password:other-link"),
      ).toBeNull();
      expect(
        await context.internalAdapter.findVerificationValue("unrelated-verification"),
      ).not.toBeNull();
      expect(
        await context.internalAdapter.findVerificationValue("reset-password:other-user-link"),
      ).not.toBeNull();
      await expect(
        current.api.resetPassword({
          body: { token: "other-link", newPassword: "replacement-password-456" },
        }),
      ).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
      expect(log).toHaveBeenCalledWith(
        "SECURITY password-reset after-sweep failed",
        userId,
        "RangeError",
      );
      db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
    },
  );

  it("refuses a gap mint after pre-sweep even when the post-sweep fails", async () => {
    const { issueMcpGrantClaims } = await import("./mcp-grant");
    let grant: Record<string, unknown> | null = null;
    (db.mcpGrant.findUnique as MockInstance).mockImplementation(async () => grant);
    (db.mcpGrant.createMany as MockInstance).mockImplementation(async ({ data }) => {
      grant = { ...data[0], id: "gap-grant", revokedAt: null };
      return { count: 1 };
    });
    let outcome: unknown;
    let sessionsInGap: unknown;
    const fixture = await resetFixture(async () => {
      // Real Better Auth hashes after the pre-sweep has released its lock,
      // before its own session deletion. The attacker still holds a signed cache.
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledTimes(1);
      const cached = await fixture.current.api.getSession({ headers: fixture.cookies[0] });
      expect(cached?.user.id).toBe(fixture.userId);
      sessionsInGap = fixture.memory.session?.filter((row) => row.userId === fixture.userId).length;
      outcome = await issueMcpGrantClaims({
        grantType: "authorization_code",
        userId: fixture.userId,
        sessionId: cached?.session.id,
        clientId: "client",
        secret: "test-credential-gap-secret-0123456789",
      }).then(
        (claims) => ({ allowed: true, claims }),
        (error: unknown) => ({ allowed: false, error }),
      );
      db.mcpAgentToken.updateMany.mockRejectedValue(new RangeError("post-sweep failed"));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const passwordBefore = fixture.memory.account?.find(
      (row) => row.userId === fixture.userId,
    )?.password;
    await expect(fixture.reset()).rejects.toBeInstanceOf(RangeError);
    expect(outcome).toMatchObject({ allowed: false, error: { status: "UNAUTHORIZED" } });
    expect(sessionsInGap).toBe(0);
    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: fixture.userId },
    });
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(fixture.memory.account?.find((row) => row.userId === fixture.userId)?.password).not.toBe(
      passwordBefore,
    );
    expect(fixture.memory.verification).toHaveLength(0);
  });

  it("returns 503 on pre-sweep verification lookup failure with password and token intact", async () => {
    const { current, memory, userId } = await resetFixture();
    const passwordBefore = memory.account?.find((row) => row.userId === userId)?.password;
    const verificationBefore = structuredClone(memory.verification);
    const context = await current.$context;
    vi.spyOn(context.internalAdapter, "findVerificationValue").mockRejectedValueOnce(
      new TypeError("private lookup details"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await current.handler(
      new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ token: "reset-token", newPassword: "replacement-password-456" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
    expect(memory.account?.find((row) => row.userId === userId)?.password).toBe(passwordBefore);
    expect(memory.verification).toEqual(verificationBefore);
    expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "SECURITY password-reset preflight failed",
      "unknown",
      "TypeError",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private lookup details");
    await expect(
      current.api.signInEmail({
        body: { email: "reset@example.com", password: "original-password-123" },
      }),
    ).resolves.toBeDefined();
    await expect(
      current.api.resetPassword({
        body: { token: "reset-token", newPassword: "replacement-password-456" },
      }),
    ).resolves.toEqual({ status: true });
  });

  it("leaves sessions revoked and password and token intact if reset fails before committing", async () => {
    const { reset, memory, userId, other } = await resetFixture(() => {
      throw new Error("hash failed after pre-sweep");
    });
    const passwordBefore = memory.account?.find((row) => row.userId === userId)?.password;
    const verificationBefore = structuredClone(memory.verification);
    await expect(reset()).rejects.toThrow("hash failed after pre-sweep");
    expect(memory.account?.find((row) => row.userId === userId)?.password).toBe(passwordBefore);
    expect(memory.verification).toEqual(verificationBefore);
    expect(memory.session?.filter((row) => row.userId === userId)).toHaveLength(0);
    expect(memory.session?.filter((row) => row.userId === other.userId)).toHaveLength(1);
  });

  it("revokes all sessions and CLI/API credentials, with cached sessions refused within 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T12:00:00Z") });
    const { current, memory, cookies, userId, other, reset } = await resetFixture();
    for (const headers of cookies) {
      expect(headers.get("cookie")).toContain("session_data=");
      expect(await current.api.getSession({ headers })).toMatchObject({ user: { id: userId } });
    }
    await expect(reset()).resolves.toEqual({ status: true });
    expect(memory.session?.filter((row) => row.userId === userId)).toHaveLength(0);
    expectCredentialRevocation(userId);
    expect(memory.user?.find((row) => row.id === userId)).toMatchObject({ emailVerified: true });
    // The deliberate cache trade-off matches a deleted session: a signed
    // cookie can resolve until its original 60-second lifetime elapses.
    for (const headers of cookies) {
      expect(await current.api.getSession({ headers })).toMatchObject({ user: { id: userId } });
    }
    vi.setSystemTime(new Date("2026-11-26T12:01:00.001Z"));
    for (const headers of cookies) {
      expect(await current.api.getSession({ headers })).toBeNull();
      const response = await current.handler(
        new Request("http://localhost:3000/api/auth/update-user", {
          method: "POST",
          headers: {
            cookie: headers.get("cookie") ?? "",
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Attacker" }),
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(await current.api.getSession({ headers: other.headers })).toMatchObject({
      user: { id: other.userId },
    });
  });

  it.each(["personal token", "OAuth grant", "access token", "refresh token", "consent", "session"])(
    "keeps the password, token and sessions usable when %s revocation fails before reset",
    async (kind) => {
      const { current, reset, memory, userId } = await resetFixture();
      const passwordBefore = memory.account?.find((row) => row.userId === userId)?.password;
      const sessionsBefore = memory.session?.filter((row) => row.userId === userId).length;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const index = [
        "personal token",
        "OAuth grant",
        "access token",
        "refresh token",
        "consent",
      ].indexOf(kind);
      const write =
        kind === "session"
          ? db.session.deleteMany
          : index < 0
            ? db.$transaction
            : revocationWrites()[index];
      if (!write) throw new Error("Missing operation");
      for (let i = 0; i < 3; i++)
        write.mockRejectedValueOnce(new TypeError("must not log private data"));
      await expect(reset()).rejects.toMatchObject({
        status: "SERVICE_UNAVAILABLE",
        body: {
          message:
            "We couldn't finish securing your account. Nothing was changed — try the link again.",
        },
      });
      expect(memory.account?.find((row) => row.userId === userId)?.password).toBe(passwordBefore);
      expect(
        memory.verification?.some((row) => row.identifier === "reset-password:reset-token"),
      ).toBe(true);
      expect(memory.session?.filter((row) => row.userId === userId)).toHaveLength(
        sessionsBefore ?? -1,
      );
      expect(log).toHaveBeenCalledWith(
        "SECURITY password-reset preflight failed",
        userId,
        "TypeError",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("private data");
      await expect(
        current.api.signInEmail({
          body: { email: "reset@example.com", password: "original-password-123" },
        }),
      ).resolves.toBeDefined();
      await expect(reset()).resolves.toEqual({ status: true });
      expect(
        memory.verification?.some((row) => row.identifier === "reset-password:reset-token"),
      ).toBe(false);
      await expect(
        current.api.signInEmail({
          body: { email: "reset@example.com", password: "replacement-password-456" },
        }),
      ).resolves.toBeDefined();
    },
  );

  it("ignores invalid and expired tokens without revoking credentials", async () => {
    const { current, memory } = await resetFixture();
    for (const row of memory.verification ?? []) row.expiresAt = new Date(0);
    for (const token of ["reset-token", "unknown"]) {
      await expect(
        current.api.resetPassword({ body: { token, newPassword: "replacement-password-456" } }),
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    }
    expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
  });

  it.each(["reset", "change-password"])(
    "the %s after-sweep invalidates credentials written in the gap, and announces recovery",
    async (operation) => {
      const { mintMcpAgentToken } = await import("@cockpit-context/db/mcp-agent-token");
      const { resolveAgentToken, resolveOauthClaims } = await vi.importActual<{
        resolveAgentToken: (
          token: string,
          options: { prisma: typeof prisma; secret: string; now: Date },
        ) => Promise<{ ok: boolean; reason?: string }>;
        resolveOauthClaims: (
          claims: Record<string, unknown>,
          options: { prisma: typeof prisma; now: Date },
        ) => Promise<{ ok: boolean; reason?: string }>;
      }>("../../../apps/server/src/mcp/credentials");
      const secret = "credential-verifier-test-secret-0123456789";
      const minted = mintMcpAgentToken(secret);
      const credential = {
        id: "gap-token",
        userId: "",
        name: "Gap",
        ...minted,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: new Date(),
        allowPropose: true,
        autoApprove: false,
        expiresAt: null,
        revokedAt: null as Date | null,
        User: { banned: false },
      };
      const grant = {
        id: "gap-grant",
        userId: "",
        clientId: "client",
        referenceId: "ref",
        clientName: "Agent",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: new Date(),
        allowPropose: true,
        autoApprove: false,
        revokedAt: null as Date | null,
        User: { banned: false },
      };
      let gapMinted = false;
      (db.mcpAgentToken.findUnique as MockInstance).mockImplementation(async () =>
        gapMinted ? credential : null,
      );
      (db.mcpGrant.findUnique as MockInstance).mockImplementation(async () =>
        gapMinted ? grant : null,
      );
      (db.mcpAgentToken.updateMany as MockInstance).mockImplementation(async () => {
        if (gapMinted) credential.revokedAt = new Date();
        return { count: gapMinted ? 1 : 0 };
      });
      (db.mcpGrant.updateMany as MockInstance).mockImplementation(async () => {
        if (gapMinted) grant.revokedAt = new Date();
        return { count: gapMinted ? 1 : 0 };
      });
      const checkToken = () => resolveAgentToken(minted.token, { prisma, secret, now: new Date() });
      const checkGrant = () =>
        resolveOauthClaims(
          { sub: grant.userId, client_id: "client", mcp_grant_id: grant.id },
          { prisma, now: new Date() },
        );
      const fixture = await resetFixture(async () => {
        // Simulate out-of-band writes while Better Auth hashes. Session-authorized
        // reset-gap issuance is refused by the regression above.
        expect(db.mcpAgentToken.updateMany).toHaveBeenCalledTimes(operation === "reset" ? 1 : 0);
        gapMinted = true;
        expect((await checkToken()).ok).toBe(true);
        expect((await checkGrant()).ok).toBe(true);
      });
      credential.userId = fixture.userId;
      grant.userId = fixture.userId;
      const announced = vi.fn();
      const stop = onUserBanned(announced);
      try {
        if (operation === "reset") await fixture.reset();
        else
          await fixture.current.api.changePassword({
            headers: fixture.cookies[0],
            body: {
              currentPassword: "original-password-123",
              newPassword: "replacement-password-456",
              revokeOtherSessions: true,
            },
          });
        expect(await checkToken()).toMatchObject({ ok: false, reason: "revoked API token" });
        expect(await checkGrant()).toMatchObject({ ok: false });
        expect(announced).toHaveBeenCalledExactlyOnceWith(fixture.userId, "session-revocation");
      } finally {
        stop();
      }
    },
  );

  it("rethrows a loud sanitized after-sweep failure", async () => {
    const { reset, userId } = await resetFixture();
    db.mcpAgentToken.updateMany.mockResolvedValueOnce({ count: 1 });
    db.mcpAgentToken.updateMany.mockRejectedValue(new RangeError("private details"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reset()).rejects.toBeInstanceOf(RangeError);
    expect(db.mcpAgentToken.updateMany).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith(
      "SECURITY password-reset after-sweep failed",
      userId,
      "RangeError",
    );
    db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([true, false])(
    "change-password revokeOtherSessions=%s preserves the caller and sweeps only when requested",
    async (revokeOtherSessions) => {
      const { current, cookies, memory, userId } = await resetFixture();
      const response = await current.api.changePassword({
        headers: cookies[0],
        returnHeaders: true,
        body: {
          currentPassword: "original-password-123",
          newPassword: "replacement-password-456",
          revokeOtherSessions,
        },
      });
      expect(db.$transaction).toHaveBeenCalledTimes(revokeOtherSessions ? 1 : 0);
      if (revokeOtherSessions) {
        expect(response.response.token).toBeTypeOf("string");
        expect(memory.session?.filter((row) => row.userId === userId)).toHaveLength(1);
        const token = response.response.token;
        const replacementHeaders = new Headers({
          cookie: response.headers
            .getSetCookie()
            .map((line) => line.split(";")[0])
            .join("; "),
        });
        expect(
          await current.api.getSession({
            headers: replacementHeaders,
            query: { disableCookieCache: true },
          }),
        ).toMatchObject({ user: { id: userId }, session: { token } });

        expect(memory.session?.some((row) => row.token === token)).toBe(true);
        expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId, revokedAt: null } }),
        );
      }
    },
  );

  it("does not revoke credentials for a failed change-password", async () => {
    const { current, cookies } = await resetFixture();
    await expect(
      current.api.changePassword({
        headers: cookies[0],
        body: {
          currentPassword: "wrong-password",
          newPassword: "replacement-password-456",
          revokeOtherSessions: true,
        },
      }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("shared OAuth revocation writes", () => {
  it.each([
    { userId: "reset-user" },
    { userId: "reset-user", clientId: "client", referenceId: "generation" },
  ])(
    "preserves the scope $userId/$clientId/$referenceId and access-before-refresh order",
    async (scope) => {
      const now = new Date("2026-11-26T12:00:00Z");
      const writes = oauthRevocationWrites(scope, now);
      await Promise.all(writes);
      expect(db.mcpGrant.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { ...scope, revokedAt: null },
        data: { revokedAt: now },
      });
      const operations = revocationWrites().slice(1);
      expect(writes).toEqual(operations.map((write) => write.mock.results[0]?.value));
      for (const write of operations.slice(1)) {
        expect(write).toHaveBeenCalledExactlyOnceWith({ where: scope });
      }
      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe("expected document identity with production before hook", () => {
  async function request(
    fixture: Awaited<ReturnType<typeof resetFixture>>,
    path: string,
    expected: string,
    body: object = {},
  ) {
    return fixture.current.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: path === "get-session" ? "GET" : "POST",
        headers: {
          cookie: fixture.other.headers.get("cookie") ?? "",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "X-Expected-User": expected,
        },
        ...(path === "get-session" ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  it.each(["update-user", "reset-password", "sign-up/email"])(
    "rejects switched cookie on %s before writes or reset revocation",
    async (path) => {
      const fixture = await resetFixture();
      const before = structuredClone(fixture.memory);
      const response = await request(fixture, path, fixture.userId, {
        name: "Changed",
        email: "new@example.com",
        password: "some-password-123",
        token: "reset-token",
        newPassword: "replacement-password-456",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "IDENTITY_CHANGED" });
      expect(fixture.memory).toEqual(before);
      for (const write of revocationWrites()) expect(write).not.toHaveBeenCalled();
    },
  );
  it("compares a banned raw cookie owner before policy filtering", async () => {
    const fixture = await resetFixture();
    const user = fixture.memory.user?.find((row) => row.id === fixture.other.userId);
    if (!user) throw new Error("Missing user");
    user.banned = true;
    const response = await request(fixture, "update-user", fixture.userId, { name: "Changed" });
    expect(response.status).toBe(409);
    expect(user.name).not.toBe("Changed");
  });
  it("allows matching writes with one authoritative lookup shared by the endpoint", async () => {
    const fixture = await resetFixture();
    const context = await fixture.current.$context;
    const lookup = vi.spyOn(context.internalAdapter, "findSession");
    expect(
      (await request(fixture, "update-user", fixture.other.userId, { name: "Changed" })).status,
    ).toBe(200);
    expect(lookup).toHaveBeenCalledOnce();
    expect(fixture.memory.user?.find((row) => row.id === fixture.other.userId)?.name).toBe(
      "Changed",
    );
  });
  it.each(["get-session", "sign-out"])(
    "exempts %s so revalidation and explicit sign-out can finish",
    async (path) => {
      const fixture = await resetFixture();
      expect((await request(fixture, path, fixture.userId)).status).toBe(200);
    },
  );
  it("fails closed when the raw owner lookup is unavailable on a recovery request", async () => {
    const fixture = await resetFixture();
    const context = await fixture.current.$context;
    const before = structuredClone(fixture.memory);
    vi.spyOn(context.internalAdapter, "findSession").mockRejectedValueOnce(
      new Error("Unavailable"),
    );
    // Use just the session token so the read cannot succeed from cookie cache.
    fixture.other.headers.set(
      "cookie",
      (fixture.other.headers.get("cookie") ?? "")
        .split("; ")
        .filter((part) => !part.startsWith("better-auth.session_data="))
        .join("; "),
    );
    const response = await request(fixture, "reset-password", fixture.userId, {
      token: "reset-token",
      newPassword: "replacement-password-456",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SESSION_UNAVAILABLE" });
    expect(fixture.memory).toEqual(before);
  });
});

it("leaves global adapter transactions off outside a reset request", async () => {
  const ctx = await auth.$context;
  expect(ctx.adapter.options?.adapterConfig.transaction).toBe(false);
});

describe("production password account hooks", () => {
  it.each(["create", "update"] as const)(
    "%s waits for quarantine and uses the production pepper after lock lapse",
    async (kind) => {
      const { withPasswordWriteLock } = await import("./password-write-lock");
      const revocation = await import("./credential-revocation");
      let release = () => {};
      let reached = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const quarantining = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const quarantine = vi
        .spyOn(revocation, "quarantineUntrustedPasswordWrite")
        .mockImplementation(async () => {
          reached();
          await pending;
        });
      db.verification.findFirst.mockResolvedValue({
        id: "v",
        identifier: "reset-password:t",
        value: "u-locked",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      db.$queryRaw.mockResolvedValue([{ locked: true }]);
      const hooks = auth.options.databaseHooks?.account?.[kind];
      if (!hooks?.before || !hooks.after) throw new Error("Missing production account hooks");
      const before = hooks.before as unknown as (
        data: { password: string },
        context: null,
      ) => Promise<unknown>;
      const after = hooks.after as unknown as (
        data: { userId: string; providerId: string; password: string },
        context: null,
      ) => Promise<unknown>;
      vi.useFakeTimers();
      let completed = false;
      const request = new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "t" }),
      });
      const response = withPasswordWriteLock(
        "/reset-password",
        request,
        async () => {
          await before({ password: "a-hash" }, null);
          await vi.advanceTimersByTimeAsync(26_000);
          try {
            await after({ userId: "u-locked", providerId: "credential", password: "a-hash" }, null);
          } finally {
            completed = true;
          }
          return new Response("unexpected");
        },
        { getSession: async () => null },
      );
      // Observe the rejection before releasing the asynchronous quarantine.
      const rejected = expect(response).rejects.toMatchObject({
        body: { code: "PASSWORD_WRITE_UNCONFIRMED" },
      });
      await quarantining;
      expect(quarantine).toHaveBeenCalledExactlyOnceWith("u-locked", { hash: passwordPepper.hash });
      await Promise.resolve();
      expect(completed).toBe(false);
      release();
      await rejected;
      expect(completed).toBe(true);
    },
  );
});

it("retries safely after all credential preflight transactions fail, preserving password and token", async () => {
  const { reset, memory } = await resetFixture();
  const before = structuredClone(memory);
  const original = db.$transaction.getMockImplementation();
  if (!original) throw new Error("Missing transaction fixture");
  let failures = 3;
  (db.$transaction as MockInstance).mockImplementation(async (work, options) => {
    // Fail credential revocation after the outer holder/setup precheck succeed.
    if (options?.isolationLevel === "ReadCommitted" && failures-- > 0)
      throw new TypeError("private preflight failure");
    return Reflect.apply(original, db, [work, options]);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(reset()).rejects.toMatchObject({ status: "SERVICE_UNAVAILABLE" });
  expect(memory.account).toEqual(before.account);
  expect(memory.verification).toEqual(before.verification);
  expect(memory.session).toEqual(before.session);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private preflight failure");
  await expect(reset()).resolves.toEqual({ status: true });
});
