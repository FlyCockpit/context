vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import { createHash } from "node:crypto";
import type { Session } from "@cockpit-context/auth";
import { isUserBanned } from "@cockpit-context/auth/ban";
import { isAdminRole } from "@cockpit-context/auth/roles";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Capture how each budget is declared and which key it is charged against,
// and let a test make the next consume throw (`createProcedureBudget` has its
// own tests).
const budget = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  charges: [] as Array<{ prefix: unknown; key: string }>,
  errorQueue: [] as unknown[],
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    budget.options.push(options);
    return async (key: string) => {
      budget.charges.push({ prefix: options.keyPrefix, key });
      const error = budget.errorQueue.shift();
      if (error) throw error;
    };
  },
}));

// Mock @cockpit-context/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[]),
  );
  return { default: db };
});

vi.mock("@cockpit-context/env/server", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000", CORS_ORIGIN: undefined },
  ADMIN_EMAILS: new Set<string>(),
}));

// Mock @cockpit-context/auth so the router's `auth.api.createUser` call hits a stub
// instead of pulling in the real better-auth (which needs an env, prisma, etc).
// `$context` stands in for Better-Auth's resolved context: the invite mints
// its set-password token through `internalAdapter.createVerificationValue`.
const { runStop, deleteRepo, invalidateAnswers } = vi.hoisted(() => ({
  runStop: vi.fn(),
  deleteRepo: vi.fn(),
  invalidateAnswers: vi.fn(),
}));
vi.mock("@cockpit-context/runs", () => ({
  getRunEngine: () => ({ stopAllForOwner: runStop }),
}));
vi.mock("@cockpit-context/runs/answer-reuse", () => ({
  invalidateAnswersForOwner: invalidateAnswers,
}));
vi.mock("@cockpit-context/repos", async () => {
  const errors = await import("@cockpit-context/repos/errors");
  return {
    deleteRepository: deleteRepo,
    REQUEST_LOCK_WAIT_MS: 10_000,
    RepoError: errors.RepoError,
    isRepoError: errors.isRepoError,
    snapshotRefMissing: vi.fn(),
    cloneRepository: vi.fn(),
    updateSnapshotRepository: vi.fn(),
  };
});

vi.mock("@cockpit-context/auth", () => {
  const authContext = {
    options: { emailAndPassword: {} as { resetPasswordTokenExpiresIn?: number } },
    internalAdapter: { createVerificationValue: vi.fn(), findVerificationValue: vi.fn() },
  };
  return {
    auth: {
      api: {
        createUser: vi.fn(),
      },
      $context: Promise.resolve(authContext),
      __authContext: authContext,
    },
  };
});

// The real grant runs (so the stubbed createUser still executes inside it); the
// spy lets a test read the grant's mode and locale.
vi.mock("@cockpit-context/auth/user-creation-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cockpit-context/auth/user-creation-policy")>();
  return { ...actual, runWithAllowedUserCreation: vi.fn(actual.runWithAllowedUserCreation) };
});

// Mock @cockpit-context/mailer so invites don't try to open SMTP. Tests assert on the
// call shape via the mock instead. `renderInviteUser` is stubbed to return a
// stable subject/html so the router can pass them straight through to
// `sendEmail` — the actual rendering is tested in the mailer package.
vi.mock("@cockpit-context/mailer", () => ({
  sendEmail: vi.fn(),
  isEmailConfigured: vi.fn(() => true),
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
  renderResetPassword: vi.fn(() => ({
    subject: "Reset your password",
    html: "<html><body>reset</body></html>",
  })),
}));

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const { default: prisma } = await import("@cockpit-context/db");
const { auth } = await import("@cockpit-context/auth");
const { env } = await import("@cockpit-context/env/server");
const { isEmailConfigured, renderInviteUser, renderResetPassword, sendEmail } = await import(
  "@cockpit-context/mailer"
);

const { runWithAllowedUserCreation } = await import("@cockpit-context/auth/user-creation-policy");
const runWithAllowedUserCreationSpy = runWithAllowedUserCreation as unknown as MockInstance;

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  conversation: { findMany: MockInstance };
  repository: { findMany: MockInstance };
  session: { deleteMany: MockInstance };
  verification: { create: MockInstance; deleteMany: MockInstance; findFirst: MockInstance };
  account: { findFirst: MockInstance };
  mcpAgentToken: { updateMany: MockInstance; findMany: MockInstance };
  mcpGrant: { updateMany: MockInstance; findMany: MockInstance };
  oauthAccessToken: { deleteMany: MockInstance; findMany: MockInstance; createMany: MockInstance };
  oauthRefreshToken: { deleteMany: MockInstance; findMany: MockInstance; createMany: MockInstance };
  oauthConsent: { deleteMany: MockInstance; findMany: MockInstance; createMany: MockInstance };
  oauthClient: { findMany: MockInstance };
  $queryRaw: MockInstance;
  $transaction: MockInstance;
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
  __authContext: {
    options: { emailAndPassword: { resetPasswordTokenExpiresIn?: number } };
    internalAdapter: { createVerificationValue: MockInstance; findVerificationValue: MockInstance };
  };
};
const createVerificationValue = authApi.__authContext.internalAdapter.createVerificationValue;
const findVerificationValue = authApi.__authContext.internalAdapter.findVerificationValue;

/** The "this link was mailed" row the router recorded for `token`, if any. */
function mailedRecordFor(token: string) {
  const identifier = `reset-password-mailed:${createHash("sha256").update(token).digest("base64url")}`;
  return createVerificationValue.mock.calls
    .map((call) => call[0] as { identifier: string; value: string; expiresAt: Date })
    .find((row) => row.identifier === identifier);
}
const mutableEnv = env as { CORS_ORIGIN?: string };
const sendEmailMock = sendEmail as unknown as MockInstance;
const isEmailConfiguredMock = isEmailConfigured as unknown as MockInstance;
const renderInviteUserMock = renderInviteUser as unknown as MockInstance;

/** The `reset-password:` row the mint wrote (an invite also writes its tag first). */
function resetRow(): { identifier: string; value: string; expiresAt: Date } {
  const rows = createVerificationValue.mock.calls.map(
    (call) => call[0] as { identifier: string; value: string; expiresAt: Date },
  );
  const row = rows.find((r) => r.identifier.startsWith("reset-password:"));
  expect(row).toBeDefined();
  return row!;
}

/** The token the invite stored, read back from the verification row it wrote. */
function mintedToken(): string {
  const row = resetRow();
  expect(row.identifier).toMatch(/^reset-password:[A-Za-z0-9_-]{32}$/);
  return row.identifier.slice("reset-password:".length);
}

/** The password `auth.api.createUser` was given, which must never leave the server. */
function createdPassword(): string {
  const call = authApi.api.createUser.mock.calls[0]?.[0] as
    | { body: { password: string } }
    | undefined;
  expect(call).toBeDefined();
  return call?.body.password ?? "";
}

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("usersRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$queryRaw.mockResolvedValue([{ count: 2 }]);
    db.$transaction.mockImplementation(async (work: unknown) =>
      typeof work === "function" ? work(prisma) : Promise.all(work as Promise<unknown>[]),
    );
    budget.charges.length = 0;
    budget.errorQueue.length = 0;
    db.conversation.findMany.mockResolvedValue([]);
    db.repository.findMany.mockResolvedValue([]);
    isEmailConfiguredMock.mockReturnValue(true);
    createVerificationValue.mockResolvedValue({});
    // Production mints on the setup transaction's client; this forwards that
    // stand-in write to the same in-memory verification table used by assertions.
    db.verification.create.mockImplementation(async ({ data }: { data: unknown }) =>
      createVerificationValue(data),
    );
    // Reads back what the mint wrote (the mailed record takes user and expiry from the link).
    findVerificationValue.mockImplementation(
      async (identifier: string) =>
        createVerificationValue.mock.calls
          .map((call) => call[0] as { identifier: string })
          .find((row) => row.identifier === identifier) ?? null,
    );
    db.verification.findFirst.mockImplementation(async ({ where }) => {
      const row = createVerificationValue.mock.calls
        .map((call) => call[0] as { identifier: string; value: string; expiresAt: Date })
        .find((candidate) => candidate.identifier === where.identifier);
      return row &&
        (!where.value || row.value === where.value) &&
        (!where.expiresAt || row.expiresAt > where.expiresAt.gt)
        ? row
        : null;
    });
    authApi.__authContext.options.emailAndPassword = {};
    mutableEnv.CORS_ORIGIN = undefined;
  });

  describe("auth gates", () => {
    it("list throws NOT_FOUND when no session", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext(null) });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("list throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("invite throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(
        client.invite({ email: "x@example.com", name: "X", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + nextCursor without a search filter", async () => {
      db.user.findMany.mockResolvedValue([
        { id: "1", email: "a@x.com", name: "A", role: "user", createdAt: new Date("2025-01-01") },
      ]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.users).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
      // No cursor on the first page: the filter stands alone in the AND.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({ AND: [{}] });
      // Never a per-page count — the UI is an infinite list.
      expect(db.user.count).not.toHaveBeenCalled();
    });

    it("takes limit + 1 to detect hasMore and mints a cursor for a full page", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@x.com`,
        name: `U ${i}`,
        role: "user",
        createdAt: new Date("2025-01-01"),
      }));
      db.user.findMany.mockResolvedValue(rows);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list({ limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
      expect(res.users).toHaveLength(10);
      expect(res.nextCursor).toEqual(expect.any(String));
    });

    it("applies a case-insensitive OR search across name and email", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ search: "alice", limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { email: { contains: "alice", mode: "insensitive" } },
              { name: { contains: "alice", mode: "insensitive" } },
            ],
          },
        ],
      });
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
    });

    it("rejects a malformed cursor", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });

    it("filters archived users in the database (banned=true)", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ banned: true }] });
    });

    it("treats active as not-banned, including NULL banned", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "active" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ OR: [{ banned: false }, { banned: null }] }] });
    });

    it("combines status and search with AND", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived", search: "alice" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            AND: [
              { banned: true },
              {
                OR: [
                  { email: { contains: "alice", mode: "insensitive" } },
                  { name: { contains: "alice", mode: "insensitive" } },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  describe("invite", () => {
    it("charges the admin's invite-mail budget before creating anyone", async () => {
      budget.errorQueue.push(new ORPCError("TOO_MANY_REQUESTS"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New", locale: "en-US" }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(budget.charges).toEqual([{ prefix: "rl:users-invite-mail", key: "admin-user-id" }]);
      expect(auth.api.createUser).not.toHaveBeenCalled();
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it("charges nothing before the admin gate or input validation", async () => {
      const user = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(
        user.invite({ email: "new@example.com", name: "New", locale: "en-US" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(user.passwordLink({ userId: "u2" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const admin = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        admin.invite({ email: "bad", name: "New", locale: "en-US" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(admin.passwordLink({ userId: "" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(budget.charges).toEqual([]);
      expect(auth.api.createUser).not.toHaveBeenCalled();
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it("declares the invite budgets fail-closed", () => {
      const declared = budget.options.filter((o) => String(o.keyPrefix).startsWith("rl:users-"));
      expect(declared.map((o) => [o.keyPrefix, o.points, o.durationSeconds, o.failClosed])).toEqual(
        [
          ["rl:users-invite-mail", 30, 3600, true],
          ["rl:users-resend-invite", 5, 3600, true],
        ],
      );
    });

    it("emails a one-time set-password link and returns no secret", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      const before = Date.now();

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "NEW@example.com",
        name: "New User",
        role: "user",
        locale: "en-US",
      });

      expect(res.userId).toBe("new-user-id");
      expect(res.emailSent).toBe(true);
      expect(res).not.toHaveProperty("setPasswordUrl");
      expect(res).not.toHaveProperty("tempPassword");
      // Email should be lowercased by the input zod schema.
      expect(authApi.api.createUser).toHaveBeenCalledWith({
        body: {
          email: "new@example.com",
          name: "New User",
          password: expect.any(String),
          role: "user",
        },
      });
      const password = createdPassword();
      expect(password.length).toBeGreaterThanOrEqual(40);
      // Neither the account's password nor the link's token reaches the admin.
      const token = mintedToken();
      expect(JSON.stringify(res)).not.toContain(password);
      expect(JSON.stringify(res)).not.toContain(token);

      // Better-Auth's own reset token: the row its reset endpoint consumes,
      // for this user, with the invite's seven-day lifetime.
      const row = resetRow();
      expect(row.value).toBe("new-user-id");
      const ttl = row.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - 10_000);
      expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS + (Date.now() - before));
      expect(res.setPasswordExpiresAt).toEqual(row.expiresAt);

      expect(renderInviteUserMock).toHaveBeenCalledWith({
        name: "New User",
        email: "new@example.com",
        setPasswordUrl: `http://localhost:3000/en-US/reset-password?token=${token}&invite=1`,
        linkExpiresInDays: 7,
        locale: "en-US",
      });
      const sent = sendEmailMock.mock.calls[0]?.[0] as { to: string; html: string };
      expect(sent.to).toBe("new@example.com");
      expect(sent.html).not.toContain(password);

      // The link was emailed, so using it will verify the address: recorded
      // per token (hash only), bound to the user and address, after the send.
      expect(mailedRecordFor(token)).toEqual({
        identifier: expect.stringMatching(/^reset-password-mailed:/),
        value: JSON.stringify({ userId: "new-user-id", email: "new@example.com" }),
        expiresAt: row.expiresAt,
      });
      expect(createVerificationValue).toHaveBeenCalledTimes(2);
      expect(createVerificationValue.mock.invocationCallOrder[1]).toBeGreaterThan(
        sendEmailMock.mock.invocationCallOrder[0]!,
      );
    });

    it("still succeeds when recording the emailed invite fails", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      createVerificationValue.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("db down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(res.emailSent).toBe(true);
      expect(res).not.toHaveProperty("setPasswordUrl");
    });

    it("returns the link instead when SMTP is not configured, without trying to send", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      isEmailConfiguredMock.mockReturnValue(false);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(res.emailSent).toBe(false);
      // A link the admin passes on proves nothing about the mailbox.
      const token = mintedToken();
      expect(mailedRecordFor(token)).toBeUndefined();
      expect(res).toMatchObject({
        userId: "new-user-id",
        setPasswordUrl: `http://localhost:3000/en-US/reset-password?token=${token}&invite=1`,
      });
      expect(JSON.stringify(res)).not.toContain(createdPassword());
    });

    it("returns the link when SMTP throws but the user was still created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("connection refused"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
      expect(res).toHaveProperty("setPasswordUrl", expect.stringContaining(mintedToken()));
      expect(db.verification.create).toHaveBeenCalledOnce();
      expect(mailedRecordFor(mintedToken())).toBeUndefined();
    });

    it("links to the web origin and the invitee's locale", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      isEmailConfiguredMock.mockReturnValue(false);
      mutableEnv.CORS_ORIGIN = "https://app.example.com";

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "es-MX",
      });

      expect(res).toHaveProperty(
        "setPasswordUrl",
        `https://app.example.com/es-MX/reset-password?token=${mintedToken()}&invite=1`,
      );
    });

    it("creates the account under the invite grant, in the chosen language", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({ email: "new@example.com", name: "New User", locale: "es-MX" });

      // The grant carries the language into the user-create hook, which saves
      // it as `User.locale` in the same insert (packages/auth).
      expect(runWithAllowedUserCreationSpy).toHaveBeenCalledWith(
        "admin-invite",
        expect.any(Function),
        { locale: "es-MX" },
      );
      expect(renderInviteUserMock).toHaveBeenCalledWith(
        expect.objectContaining({ locale: "es-MX" }),
      );
    });

    it("refuses an unsupported language before creating anything", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({
          email: "new@example.com",
          name: "New User",
          // @ts-expect-error -- not one of SUPPORTED_LOCALES
          locale: "fr-FR",
        }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });

    it("keeps the seven-day lifetime whatever the reset-token setting is", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      isEmailConfiguredMock.mockReturnValue(false);
      // Better-Auth reads this only when *requesting* a reset; the invite's
      // own row carries its own expiry.
      authApi.__authContext.options.emailAndPassword = { resetPasswordTokenExpiresIn: 600 };
      const before = Date.now();

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      const ttl = res.setPasswordExpiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - 10_000);
      expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS + (Date.now() - before));
    });

    it("says so when the link can't be minted after the account was created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      createVerificationValue.mockRejectedValue(new Error("db down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New User", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("INTERNAL_SERVER_ERROR");
        expect(e.message).toMatch(/delete the user and invite them again/i);
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "dup@example.com", name: "Dup", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New User", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        expect(e.message).toMatch(/account creation is disabled/i);
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("setRole", () => {
    let audit: MockInstance;
    const target = {
      id: "other-user-id",
      role: "user",
      emailVerified: true,
      banned: false,
      banExpires: null,
    };
    const client = () => createRouterClient(usersRouter, { context: buildContext() });
    const changeRole = (role: "admin" | "user") => client().setRole({ userId: target.id, role });

    beforeEach(() => {
      audit = vi.spyOn(console, "warn").mockImplementation(() => {});
      db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) =>
        run(prisma),
      );
      db.user.findUnique.mockResolvedValue(target);
      db.user.update.mockResolvedValue({ id: target.id });
      db.$queryRaw.mockResolvedValue([{ count: 2 }]);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      db.$transaction.mockReset();
    });

    it.each([
      ["user", "admin"],
      ["admin", "user"],
      ["user, Admin", "user"],
    ] as const)(
      "changes %s to %s and audits the committed change once",
      async (oldRole, newRole) => {
        db.user.findUnique.mockResolvedValue({ ...target, role: oldRole });
        await expect(changeRole(newRole)).resolves.toEqual({ success: true });
        expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          isolationLevel: "Serializable",
        });
        expect(db.user.findUnique).toHaveBeenCalledWith({
          where: { id: target.id },
          select: { id: true, role: true, emailVerified: true, banned: true, banExpires: true },
        });
        expect(db.user.update).toHaveBeenCalledExactlyOnceWith({
          where: { id: target.id },
          data: { role: newRole },
        });
        expect(audit).toHaveBeenCalledOnce();
        const line: string = audit.mock.calls[0]?.[0];
        expect(line).toMatch(/^\[audit\] /);
        expect(JSON.parse(line.slice("[audit] ".length))).toEqual({
          audit: "admin",
          action: "users.role_changed",
          actorUserId: "admin-user-id",
          targetUserId: target.id,
          details: { oldRole, newRole },
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        });
        if (newRole === "user") expect(db.$queryRaw).toHaveBeenCalledOnce();
        else expect(db.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it("refuses demoting the last active admin", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, role: "admin" });
      db.$queryRaw.mockResolvedValue([{ count: 1 }]);
      await expect(changeRole("user")).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "LAST_ACTIVE_ADMIN" },
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("recounts inside each transaction rather than reusing an earlier count", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, role: "admin" });
      db.$queryRaw.mockResolvedValueOnce([{ count: 2 }]).mockResolvedValueOnce([{ count: 1 }]);
      await expect(changeRole("user")).resolves.toEqual({ success: true });
      await expect(changeRole("user")).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
      expect(db.user.update).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledOnce();
    });

    it("blocks the admin from demoting themselves", async () => {
      await expect(
        client().setRole({ userId: "admin-user-id", role: "user" }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "SELF_DEMOTION" },
      });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it.each(["user", "admin"] as const)(
      "returns success without writes or audit for same-role %s",
      async (role) => {
        db.user.findUnique.mockResolvedValue({ ...target, role });
        await expect(changeRole(role)).resolves.toEqual({ success: true });
        expect(db.user.update).not.toHaveBeenCalled();
        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
      },
    );

    it("allows the current admin's same-role no-op", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, id: "admin-user-id", role: "admin" });
      await expect(client().setRole({ userId: "admin-user-id", role: "admin" })).resolves.toEqual({
        success: true,
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("can demote an archived admin without counting it as active", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, role: "admin", banned: true });
      await expect(changeRole("user")).resolves.toEqual({ success: true });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledOnce();
    });

    it("includes an admin with an expired ban in the last-admin guard", async () => {
      db.user.findUnique.mockResolvedValue({
        ...target,
        role: "admin",
        banned: true,
        banExpires: new Date(0),
      });
      db.$queryRaw.mockResolvedValue([{ count: 1 }]);
      await expect(changeRole("user")).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("returns a retry message and emits no audit if serialization fails at commit", async () => {
      db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => {
        await run(prisma);
        throw { code: "P2034" };
      });
      await expect(changeRole("admin")).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason: "USER_CHANGE_CONFLICT" },
      });
      expect(db.user.update).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalled();
    });

    it("does not audit a failed update", async () => {
      db.user.update.mockRejectedValueOnce(new Error("database unavailable"));
      await expect(changeRole("admin")).rejects.toThrow("database unavailable");
      expect(audit).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      await expect(client().setRole({ userId: "missing", role: "user" })).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { reason: "USER_NOT_FOUND" },
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe.each(["setRole", "archive", "remove"] as const)(
    "%s admin-removal invariant",
    (operation) => {
      const run = (userId = "target") => {
        const client = createRouterClient(usersRouter, { context: buildContext() });
        return operation === "setRole"
          ? client.setRole({ userId, role: "user" })
          : client[operation]({ userId });
      };
      let tx: ReturnType<typeof mockDeep<typeof prisma>>;
      beforeEach(() => {
        tx = mockDeep<typeof prisma>();
        tx.user.findUnique.mockResolvedValue({
          id: "target",
          role: "user, Admin",
          emailVerified: true,
          banned: false,
          banExpires: null,
        } as Awaited<ReturnType<typeof prisma.user.findUnique>>);
        tx.$queryRaw.mockResolvedValue([{ count: 1 }]);
        db.$transaction.mockImplementation(async (body: unknown) =>
          typeof body === "function" ? body(tx) : Promise.all(body as Promise<unknown>[]),
        );
      });
      afterEach(() => db.$transaction.mockReset());

      it("refuses the last verified active admin using only transaction reads, before any write", async () => {
        await expect(run()).rejects.toMatchObject({
          code: "FORBIDDEN",
          data: { reason: "LAST_ACTIVE_ADMIN" },
        });
        expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          isolationLevel: "Serializable",
        });
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.user.delete).not.toHaveBeenCalled();
        expect(tx.session.deleteMany).not.toHaveBeenCalled();
        expect(db.user.findUnique).not.toHaveBeenCalled();
      });

      it("writes and revokes sessions on the same transaction after recounting", async () => {
        tx.$queryRaw.mockResolvedValue([{ count: 2 }]);
        const expected =
          operation === "archive"
            ? { success: true, undoToken: expect.any(String) }
            : { success: true };
        await expect(run()).resolves.toEqual(expected);
        // Deletion first removes access transactionally, then cleans repositories.
        const write = tx.user.update;
        expect(write).toHaveBeenCalledOnce();
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          write.mock.invocationCallOrder[0] ?? 0,
        );
        if (operation === "archive")
          expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "target" } });
      });

      it("preserves the missing-target reason", async () => {
        tx.user.findUnique.mockResolvedValue(null);
        await expect(run()).rejects.toMatchObject({
          code: "NOT_FOUND",
          data: { reason: "USER_NOT_FOUND" },
        });
      });

      it("reports a retryable serialization conflict without hiding it behind delete failure", async () => {
        db.$transaction.mockRejectedValueOnce({ code: "P2034" });
        await expect(run()).rejects.toMatchObject({
          code: "CONFLICT",
          data: { reason: "USER_CHANGE_CONFLICT" },
        });
      });

      it("allows removal of an unverified invite without treating it as the last usable admin", async () => {
        tx.user.findUnique.mockResolvedValue({
          id: "target",
          role: "admin",
          emailVerified: false,
          banned: false,
          banExpires: null,
        } as Awaited<ReturnType<typeof prisma.user.findUnique>>);
        const expected =
          operation === "archive"
            ? { success: true, undoToken: expect.any(String) }
            : { success: true };
        await expect(run()).resolves.toEqual(expected);
        expect(tx.$queryRaw).not.toHaveBeenCalled();
      });
    },
  );

  describe("removals with a retained admin cookie", () => {
    const operations = ["setRole", "archive", "remove"] as const;
    afterEach(() => db.$transaction.mockReset());
    it.each(operations.flatMap((first) => operations.map((second) => [first, second] as const)))(
      "recounts after %s before allowing a stale admin's %s",
      async (first, second) => {
        const rows = new Map([
          ["a", { id: "a", role: "admin", emailVerified: true, banned: false, banExpires: null }],
          ["b", { id: "b", role: "admin", emailVerified: true, banned: false, banExpires: null }],
          [
            "invite",
            { id: "invite", role: "admin", emailVerified: false, banned: false, banExpires: null },
          ],
        ]);
        const tx = mockDeep<typeof prisma>();
        // Prisma's fluent clients expose relation methods as well as a promise;
        // these stubs only model the awaited IO boundary used by the guard.
        const store = tx as unknown as typeof db;
        store.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
          const user = rows.get(where.id);
          return user ? { ...user } : null;
        });
        // Mock the SQL boundary using the verified/active contract tested in
        // admin-presence.test.ts. State changes here survive between calls.
        store.$queryRaw.mockImplementation(async () => [
          {
            count: [...rows.values()].filter(
              (u) => u.emailVerified && u.role === "admin" && !u.banned,
            ).length,
          },
        ]);
        store.user.update.mockImplementation(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { role?: unknown; banned?: unknown };
          }) => {
            const user = rows.get(where.id);
            if (!user) throw new Error("Missing test user");
            if (typeof data.role === "string") user.role = data.role;
            if (typeof data.banned === "boolean") user.banned = data.banned;
            return user;
          },
        );
        store.user.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
          const user = rows.get(where.id);
          rows.delete(where.id);
          return user;
        });
        db.$transaction.mockImplementation(async (body: unknown) =>
          typeof body === "function" ? body(tx) : Promise.all(body as Promise<unknown>[]),
        );
        const request = (
          actorId: string,
          targetId: string,
          operation: (typeof operations)[number],
        ) => {
          const client = createRouterClient(usersRouter, {
            context: buildContext({ user: { id: actorId } }),
          });
          return operation === "setRole"
            ? client.setRole({ userId: targetId, role: "user" })
            : client[operation]({ userId: targetId });
        };
        const expectedFirst =
          first === "archive"
            ? { success: true, undoToken: expect.any(String) }
            : { success: true };
        await expect(request("a", "b", first)).resolves.toEqual(expectedFirst);
        await expect(request("b", "a", second)).rejects.toMatchObject({
          code: "FORBIDDEN",
          data: { reason: "LAST_ACTIVE_ADMIN" },
        });
        expect(rows.get("a")).toMatchObject({ role: "admin", emailVerified: true, banned: false });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        const guarded = db.$transaction.mock.calls.filter(
          (call) => call[1]?.isolationLevel === "Serializable",
        );
        expect(guarded).toHaveLength(first === "remove" ? 3 : 2);
        for (const call of guarded) expect(call[0]).toEqual(expect.any(Function));
      },
    );
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true, undoToken: expect.any(String) });
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "other-user-id" } });
    });

    it("announces the ban after the transaction, which closes the user's live streams", async () => {
      const { onUserBanned } = await import("@cockpit-context/auth/ban");
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      const order: string[] = [];
      db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => {
        const result = await run(prisma);
        order.push("commit");
        return result;
      });
      const stop = onUserBanned((userId) => order.push(`announce:${userId}`));
      try {
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await client.archive({ userId: "other-user-id" });
      } finally {
        stop();
      }
      expect(order).toEqual(["commit", "announce:other-user-id"]);
    });

    it("stops the runs of a user banned through the admin plugin, and only for that origin", async () => {
      const { announceUserBanned: announce } = await import("@cockpit-context/auth/ban");
      announce("app-banned-user");
      expect(runStop).not.toHaveBeenCalledWith("app-banned-user");
      const { announceUserBanned } = await import("@cockpit-context/auth/ban");
      announceUserBanned("plugin-banned-user", "auth-plugin");
      await vi.waitFor(() => expect(runStop).toHaveBeenCalledWith("plugin-banned-user"));
    });

    it("revokes every MCP token and OAuth connection in the same transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.archive({ userId: "other-user-id" });

      const owner = { userId: "other-user-id" };
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
        where: { ...owner, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
        where: { ...owner, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledWith({ where: owner });
      expect(db.oauthRefreshToken.deleteMany).toHaveBeenCalledWith({ where: owner });
      expect(db.oauthConsent.deleteMany).toHaveBeenCalledWith({ where: owner });
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
    });

    it("blocks self-archive", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.archive({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          return true;
        },
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  it("stops all of an archived user's runs (main and summary) after access revocation", async () => {
    db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
    await createRouterClient(usersRouter, { context: buildContext() }).archive({
      userId: "other-user-id",
    });
    expect(runStop.mock.calls).toEqual([["other-user-id"]]);
    expect(db.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      runStop.mock.invocationCallOrder[0],
    );
  });

  it("drops an archived or deleted user's reusable MCP answers", async () => {
    db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
    const client = createRouterClient(usersRouter, { context: buildContext() });
    await client.archive({ userId: "other-user-id" });
    expect(invalidateAnswers.mock.calls).toEqual([["other-user-id"]]);
    invalidateAnswers.mockClear();
    db.repository.findMany.mockResolvedValue([]);
    await client.remove({ userId: "other-user-id" });
    expect(invalidateAnswers.mock.calls).toEqual([["other-user-id"]]);
  });

  describe("unarchive", () => {
    it("clears banned + banReason + banExpires", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true, restoredConnections: false });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
    });

    it("does not restore the MCP credentials archive revoked when no undoToken is passed", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true, restoredConnections: false });
      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
      expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
      expect(db.oauthConsent.createMany).not.toHaveBeenCalled();
      expect(db.oauthRefreshToken.createMany).not.toHaveBeenCalled();
      expect(db.oauthAccessToken.createMany).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: "archive-undo:other-user-id" },
      });
    });

    it("restores archive-revoked MCP and OAuth connections when called with the archive undoToken", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id", banned: false } as never);
      db.mcpAgentToken.findMany.mockResolvedValue([{ id: "tok-1" }] as never);
      db.mcpGrant.findMany.mockResolvedValue([{ id: "grant-1" }] as never);
      db.oauthConsent.findMany.mockResolvedValue([
        {
          id: "consent-1",
          clientId: "client-1",
          referenceId: "ref-1",
          resources: [],
          requestedUserInfoClaims: [],
          scopes: ["openid"],
          createdAt: new Date("2026-11-26T00:00:00.000Z"),
          updatedAt: new Date("2026-11-26T00:00:00.000Z"),
        },
      ] as never);
      db.oauthRefreshToken.findMany.mockResolvedValue([] as never);
      db.oauthAccessToken.findMany.mockResolvedValue([] as never);

      let storedRecord: { identifier: string; value: string; expiresAt: Date } | null = null;
      db.verification.create.mockImplementation((async ({
        data,
      }: {
        data: { identifier: string; value: string; expiresAt: Date };
      }) => {
        storedRecord = data;
        return data;
      }) as never);
      db.verification.findFirst.mockImplementation((async () => storedRecord) as never);
      db.oauthClient.findMany.mockResolvedValue([{ clientId: "client-1" }] as never);
      db.user.update.mockResolvedValue({} as never);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const archived = await client.archive({ userId: "other-user-id" });
      expect(archived.undoToken).toEqual(expect.any(String));

      const restored = await client.unarchive({
        userId: "other-user-id",
        undoToken: archived.undoToken,
      });

      expect(restored).toEqual({ success: true, restoredConnections: true });
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["tok-1"] }, userId: "other-user-id", revokedAt: expect.any(Date) },
        data: { revokedAt: null },
      });
      expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["grant-1"] }, userId: "other-user-id", revokedAt: expect.any(Date) },
        data: { revokedAt: null },
      });
      expect(db.oauthConsent.createMany).toHaveBeenCalledOnce();
    });

    it("refuses undoToken unarchive when archive-undo snapshot was cleared or expired", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" } as never);
      db.verification.findFirst.mockResolvedValue(null as never);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.unarchive({ userId: "other-user-id", undoToken: "stale-token" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("omits undoToken and invalidates any earlier undo snapshot when archiving an already-banned user", async () => {
      db.user.findUnique.mockResolvedValue({
        id: "other-user-id",
        banned: true,
        banExpires: null,
      } as never);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({ userId: "other-user-id" });
      expect(res.undoToken).toBeUndefined();
      expect(db.verification.create).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: "archive-undo:other-user-id" },
      });
    });

    it("rejects the first admin's undoToken after a second admin re-archives the banned user", async () => {
      let storedRecord: { identifier: string; value: string; expiresAt: Date } | null = null;
      db.user.findUnique.mockResolvedValueOnce({
        id: "other-user-id",
        banned: false,
        banExpires: null,
      } as never);
      db.mcpAgentToken.findMany.mockResolvedValue([{ id: "tok-1" }] as never);
      db.mcpGrant.findMany.mockResolvedValue([] as never);
      db.oauthConsent.findMany.mockResolvedValue([] as never);
      db.oauthRefreshToken.findMany.mockResolvedValue([] as never);
      db.oauthAccessToken.findMany.mockResolvedValue([] as never);
      db.verification.create.mockImplementation((async ({
        data,
      }: {
        data: { identifier: string; value: string; expiresAt: Date };
      }) => {
        storedRecord = data;
        return data;
      }) as never);
      db.verification.deleteMany.mockImplementation((async () => {
        storedRecord = null;
        return { count: 1 };
      }) as never);
      db.verification.findFirst.mockImplementation((async () => storedRecord) as never);
      db.user.update.mockResolvedValue({} as never);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const firstArchive = await client.archive({ userId: "other-user-id" });
      expect(firstArchive.undoToken).toEqual(expect.any(String));

      db.user.findUnique.mockResolvedValue({
        id: "other-user-id",
        banned: true,
        banExpires: null,
      } as never);
      const secondArchive = await client.archive({ userId: "other-user-id" });
      expect(secondArchive.undoToken).toBeUndefined();

      await expect(
        client.unarchive({ userId: "other-user-id", undoToken: firstArchive.undoToken }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("remove", () => {
    it("hard-deletes when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "other-user-id" } });
    });

    it.each(["after the initial ban", "during repository cleanup"] as const)(
      "preserves the last admin restored %s while the deleting admin is demoted",
      async (timing) => {
        const admin = {
          id: "admin-user-id",
          role: "admin",
          emailVerified: true,
          banned: false,
          banExpires: null,
        };
        const target = { ...admin, id: "other-user-id" };
        const users = new Map([
          [admin.id, admin],
          [target.id, target],
        ]);
        const activeCount = () =>
          [...users.values()].filter(
            (user) => isAdminRole(user.role) && user.emailVerified && !isUserBanned(user),
          ).length;
        db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
          const user = users.get(where.id);
          return user ? { ...user } : null;
        });
        db.user.update.mockImplementation(
          async ({ where, data }: { where: { id: string }; data: Partial<typeof target> }) => {
            const user = users.get(where.id);
            if (!user) throw new Error("User not found");
            Object.assign(user, data);
            return { ...user };
          },
        );
        db.user.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
          const user = users.get(where.id);
          users.delete(where.id);
          return user;
        });
        db.$queryRaw.mockImplementation(async () => [{ count: activeCount() }]);
        const client = createRouterClient(usersRouter, { context: buildContext() });
        let interleaved = false;
        const restoreAndDemote = async () => {
          interleaved = true;
          expect(target.banned).toBe(true);
          await client.unarchive({ userId: target.id });
          await createRouterClient(usersRouter, {
            context: buildContext({ user: { id: target.id } }),
          }).setRole({ userId: admin.id, role: "user" });
          expect(activeCount()).toBe(1);
        };
        db.$transaction.mockImplementation(async (run: unknown) => {
          const result =
            typeof run === "function"
              ? await run(prisma)
              : await Promise.all(run as Promise<unknown>[]);
          if (timing === "after the initial ban" && !interleaved) await restoreAndDemote();
          return result;
        });
        if (timing === "during repository cleanup") {
          db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
          deleteRepo.mockImplementationOnce(restoreAndDemote);
        }
        try {
          await expect(client.remove({ userId: target.id })).rejects.toMatchObject({
            code: "FORBIDDEN",
            data: { reason: "LAST_ACTIVE_ADMIN" },
          });
          expect(interleaved).toBe(true);
          expect(runStop).toHaveBeenCalledOnce();
          expect(users.get(target.id)).toMatchObject({ role: "admin", banned: false });
          expect(activeCount()).toBe(1);
          expect(db.user.delete).not.toHaveBeenCalled();
        } finally {
          db.user.findUnique.mockReset();
          db.user.update.mockReset();
          db.user.delete.mockReset();
        }
      },
    );

    it("cleans up private repositories before cascading the user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
      await createRouterClient(usersRouter, { context: buildContext() }).remove({
        userId: "other-user-id",
      });
      expect(runStop).toHaveBeenCalledExactlyOnceWith("other-user-id");
      expect(deleteRepo).toHaveBeenCalledWith("private-1", { force: true, lockWaitMs: 10_000 });
      expect(deleteRepo.mock.invocationCallOrder[0]).toBeLessThan(
        db.user.delete.mock.invocationCallOrder[0],
      );
      expect(db.repository.findMany.mock.calls[0]?.[0].where).toEqual({
        ownerId: "other-user-id",
        visibility: "PRIVATE",
      });
    });

    it("registers the same cleanup for Better-Auth's admin remove-user hook", async () => {
      const { cleanupBeforeUserDeletion } = await import(
        "@cockpit-context/auth/user-creation-policy"
      );
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
      await cleanupBeforeUserDeletion("other-user-id");
      expect(deleteRepo).toHaveBeenCalledWith("private-1", { force: true, lockWaitMs: 10_000 });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("leaves the user row when repository cleanup fails", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
      deleteRepo.mockRejectedValueOnce(new Error("cleanup unavailable"));
      await expect(
        createRouterClient(usersRouter, { context: buildContext() }).remove({
          userId: "other-user-id",
        }),
      ).rejects.toThrow("cleanup unavailable");
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });
  });

  describe("passwordLink", () => {
    const target = {
      id: "other-user-id",
      email: "alice@example.com",
      locale: "es-MX",
      banned: false,
    };
    let warn: MockInstance;

    beforeEach(() => {
      db.user.findUnique.mockResolvedValue(target);
      db.account.findFirst.mockResolvedValue({ id: "acct-1" });
      db.verification.deleteMany.mockResolvedValue({ count: 0 });
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      (renderResetPassword as unknown as MockInstance).mockReturnValue({
        subject: "Reset your password",
        html: "<html><body>reset</body></html>",
      });
      sendEmailMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const audits = () =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[audit] "))
        .map((line) => JSON.parse(line.slice("[audit] ".length)));

    it("charges the admin's invite-mail budget and the target's resend budget first", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.passwordLink({ userId: target.id });
      expect(budget.charges).toEqual([
        { prefix: "rl:users-invite-mail", key: "admin-user-id" },
        { prefix: "rl:users-resend-invite", key: target.id },
      ]);
    });
    it.each(["TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"] as const)(
      "mints and mails nothing once a budget fails: %s",
      async (code) => {
        budget.errorQueue.push(undefined, new ORPCError(code));
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(client.passwordLink({ userId: target.id })).rejects.toMatchObject({ code });
        expect(db.verification.deleteMany).not.toHaveBeenCalled();
        expect(createVerificationValue).not.toHaveBeenCalled();
        expect(sendEmailMock).not.toHaveBeenCalled();
      },
    );

    it("throws NOT_FOUND for a non-admin and mints nothing", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.passwordLink({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
      expect(createVerificationValue).not.toHaveBeenCalled();
      expect(audits()).toEqual([]);
    });

    it("refuses an archived user", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, banned: true });
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.passwordLink({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          expect(e.message).toMatch(/archived/i);
          return true;
        },
      );
      expect(createVerificationValue).not.toHaveBeenCalled();
    });

    it("refuses an SSO-only account (no password credential to set)", async () => {
      db.account.findFirst.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.passwordLink({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          return true;
        },
      );
      expect(db.account.findFirst.mock.calls[0]?.[0].where).toEqual({
        userId: "other-user-id",
        providerId: "credential",
      });
      expect(createVerificationValue).not.toHaveBeenCalled();
    });

    it("refuses an unknown user and the admin's own account", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.passwordLink({ userId: "missing" })).rejects.toSatisfy(
        (e: ORPCError) => e.code === "NOT_FOUND",
      );
      await expect(client.passwordLink({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => e.code === "FORBIDDEN",
      );
      expect(createVerificationValue).not.toHaveBeenCalled();
    });

    it("without SMTP returns a one-time link bound to the user, superseding older ones", async () => {
      isEmailConfiguredMock.mockReturnValue(false);
      const before = Date.now();
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.passwordLink({ userId: "other-user-id" });

      expect(res.emailSent).toBe(false);
      if (res.emailSent) throw new Error("unreachable");
      const token = mintedToken();
      const url = new URL(res.setPasswordUrl);
      expect(url.origin + url.pathname).toBe("http://localhost:3000/es-MX/reset-password");
      expect(url.searchParams.get("token")).toBe(token);
      // A reset, not an invitation.
      expect(url.searchParams.has("invite")).toBe(false);
      const row = createVerificationValue.mock.calls[0]?.[0] as { value: string; expiresAt: Date };
      expect(row.value).toBe("other-user-id");
      // Shown, not mailed: only the reset row, no mailed record.
      expect(createVerificationValue).toHaveBeenCalledTimes(1);
      // Same lifetime as an invite link.
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS);
      // Older reset links die first.
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: { startsWith: "reset-password:" }, value: "other-user-id" },
      });
      expect(db.verification.deleteMany.mock.invocationCallOrder.at(-1)).toBeLessThan(
        createVerificationValue.mock.invocationCallOrder[0]!,
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
      // An un-emailed link records nothing (it proves nothing about the mailbox).
      expect(mailedRecordFor(token)).toBeUndefined();
    });

    it("writes an audit entry that never carries the link", async () => {
      isEmailConfiguredMock.mockReturnValue(false);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.passwordLink({ userId: "other-user-id" });
      expect(audits()).toEqual([
        {
          audit: "admin",
          action: "users.passwordLink",
          actorUserId: "admin-user-id",
          targetUserId: "other-user-id",
          at: expect.any(String),
          details: { delivery: "admin", expiresAt: expect.any(String) },
        },
      ]);
      const token = mintedToken();
      for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(token);
    });

    it("with SMTP emails the link to the user and never returns it to the admin", async () => {
      isEmailConfiguredMock.mockReturnValue(true);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.passwordLink({ userId: "other-user-id" });
      expect(res).toEqual({ emailSent: true, setPasswordExpiresAt: expect.any(Date) });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "alice@example.com", subject: "Reset your password" }),
      );
      expect(mailedRecordFor(mintedToken())).toMatchObject({
        value: JSON.stringify({ userId: "other-user-id", email: "alice@example.com" }),
      });
      expect(audits()[0]?.details.delivery).toBe("email");
    });

    it("with SMTP, a failed send revokes the link and never returns it", async () => {
      isEmailConfiguredMock.mockReturnValue(true);
      sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      let caught: unknown;
      try {
        await client.passwordLink({ userId: "other-user-id" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ORPCError);
      const err = caught as ORPCError<string, { reason: string }>;
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
      expect(err.data).toEqual({ reason: "PASSWORD_LINK_DELIVERY_FAILED" });
      const token = mintedToken();
      expect(JSON.stringify(err)).not.toContain(token);
      // The undelivered token is deleted, so nothing live is left behind.
      expect(db.verification.deleteMany).toHaveBeenLastCalledWith({
        where: { identifier: `reset-password:${token}` },
      });
      expect(mailedRecordFor(token)).toBeUndefined();
      expect(audits()[0]?.details).toEqual({ delivery: "failed" });
      for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(token);
    });

    it("refuses an administrator target (demote first)", async () => {
      db.user.findUnique.mockResolvedValue({ ...target, role: "admin" });
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.passwordLink({ userId: "other-user-id" })).rejects.toSatisfy(
        (e: ORPCError<string, { reason: string }>) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.data).toEqual({ reason: "PASSWORD_LINK_ADMIN_TARGET" });
          return true;
        },
      );
      expect(createVerificationValue).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).not.toHaveBeenCalled();
    });

    it("two concurrent requests for one user leave exactly one live link", async () => {
      isEmailConfiguredMock.mockReturnValue(false);
      // A tiny verification store whose writes yield, so unserialized
      // issuances would interleave (delete, delete, create, create).
      const rows = new Map<string, string>();
      const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
      db.verification.deleteMany.mockImplementation(
        async (args: {
          where: { identifier: string | { startsWith: string }; value?: string };
        }) => {
          await tick();
          for (const [identifier, value] of rows) {
            const id = args.where.identifier;
            const matches =
              typeof id === "string"
                ? identifier === id
                : identifier.startsWith(id.startsWith) && value === args.where.value;
            if (matches) rows.delete(identifier);
          }
          return { count: 0 };
        },
      );
      createVerificationValue.mockImplementation(
        async (row: { identifier: string; value: string }) => {
          await tick();
          rows.set(row.identifier, row.value);
        },
      );
      const client = createRouterClient(usersRouter, { context: buildContext() });
      // The second is refused at once (CONFLICT / PASSWORD_LINK_BUSY), never
      // queued behind the first's mail budget; one link is issued.
      const first = client.passwordLink({ userId: "other-user-id" });
      const second = client.passwordLink({ userId: "other-user-id" }).then(
        () => null,
        (error: unknown) => error,
      );
      await expect(first).resolves.toMatchObject({ emailSent: false });
      expect(await second).toMatchObject({
        code: "CONFLICT",
        data: { reason: "PASSWORD_LINK_BUSY" },
      });
      const live = [...rows.keys()].filter((id) => id.startsWith("reset-password:"));
      expect(live).toHaveLength(1);
      expect(createVerificationValue).toHaveBeenCalledTimes(1);
      // Free again once the first finished.
      await expect(client.passwordLink({ userId: "other-user-id" })).resolves.toMatchObject({
        emailSent: false,
      });
      expect([...rows.keys()].filter((id) => id.startsWith("reset-password:"))).toHaveLength(1);
    });
  });
});
