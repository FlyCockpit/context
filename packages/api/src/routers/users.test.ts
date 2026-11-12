import type { Session } from "@cockpit-context/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @cockpit-context/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
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
vi.mock("@cockpit-context/repos", () => ({ deleteRepository: deleteRepo }));

vi.mock("@cockpit-context/auth", () => {
  const authContext = {
    options: { emailAndPassword: {} as { resetPasswordTokenExpiresIn?: number } },
    internalAdapter: { createVerificationValue: vi.fn() },
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
  verification: { create: MockInstance; deleteMany: MockInstance };
  account: { findFirst: MockInstance };
  mcpAgentToken: { updateMany: MockInstance };
  mcpGrant: { updateMany: MockInstance };
  oauthAccessToken: { deleteMany: MockInstance };
  oauthRefreshToken: { deleteMany: MockInstance };
  oauthConsent: { deleteMany: MockInstance };
  $transaction: MockInstance;
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
  __authContext: {
    options: { emailAndPassword: { resetPasswordTokenExpiresIn?: number } };
    internalAdapter: { createVerificationValue: MockInstance };
  };
};
const createVerificationValue = authApi.__authContext.internalAdapter.createVerificationValue;
const mutableEnv = env as { CORS_ORIGIN?: string };
const sendEmailMock = sendEmail as unknown as MockInstance;
const isEmailConfiguredMock = isEmailConfigured as unknown as MockInstance;
const renderInviteUserMock = renderInviteUser as unknown as MockInstance;

/** The token the invite stored, read back from the verification row it wrote. */
function mintedToken(): string {
  const row = createVerificationValue.mock.calls[0]?.[0] as { identifier: string };
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
    db.conversation.findMany.mockResolvedValue([]);
    db.repository.findMany.mockResolvedValue([]);
    isEmailConfiguredMock.mockReturnValue(true);
    createVerificationValue.mockResolvedValue({});
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
      await expect(client.invite({ email: "x@example.com", name: "X" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
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
    it("emails a one-time set-password link and returns no secret", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      const before = Date.now();

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "NEW@example.com",
        name: "New User",
        role: "user",
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
      const row = createVerificationValue.mock.calls[0]?.[0] as {
        value: string;
        expiresAt: Date;
      };
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

      // The link was emailed, so using it will verify the address.
      expect(db.verification.create).toHaveBeenCalledWith({
        data: {
          identifier: "invite-email-delivered:new-user-id",
          value: "new@example.com",
          expiresAt: row.expiresAt,
        },
      });
    });

    it("still succeeds when recording the emailed invite fails", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      db.verification.create.mockRejectedValueOnce(new Error("db down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New User" });

      expect(res.emailSent).toBe(true);
      expect(res).not.toHaveProperty("setPasswordUrl");
    });

    it("returns the link instead when SMTP is not configured, without trying to send", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      isEmailConfiguredMock.mockReturnValue(false);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New User" });

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(res.emailSent).toBe(false);
      // A link the admin passes on proves nothing about the mailbox.
      expect(db.verification.create).not.toHaveBeenCalled();
      const token = mintedToken();
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
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
      expect(res).toHaveProperty("setPasswordUrl", expect.stringContaining(mintedToken()));
      expect(db.verification.create).not.toHaveBeenCalled();
    });

    it("links to the web origin and the invitee's locale", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      db.user.findUnique.mockResolvedValue({ locale: "es-MX" });
      isEmailConfiguredMock.mockReturnValue(false);
      mutableEnv.CORS_ORIGIN = "https://app.example.com";

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New User" });

      expect(res).toHaveProperty(
        "setPasswordUrl",
        `https://app.example.com/es-MX/reset-password?token=${mintedToken()}&invite=1`,
      );
    });

    it("keeps the seven-day lifetime whatever the reset-token setting is", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      isEmailConfiguredMock.mockReturnValue(false);
      // Better-Auth reads this only when *requesting* a reset; the invite's
      // own row carries its own expiry.
      authApi.__authContext.options.emailAndPassword = { resetPasswordTokenExpiresIn: 600 };
      const before = Date.now();

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New User" });

      const ttl = res.setPasswordExpiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - 10_000);
      expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS + (Date.now() - before));
    });

    it("says so when the link can't be minted after the account was created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      createVerificationValue.mockRejectedValue(new Error("db down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "new@example.com", name: "New User" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("INTERNAL_SERVER_ERROR");
          expect(e.message).toMatch(/delete the user and invite them again/i);
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "dup@example.com", name: "Dup" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("CONFLICT");
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.invite({ email: "new@example.com", name: "New User" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          expect(e.message).toMatch(/account creation is disabled/i);
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("setRole", () => {
    it("updates the role on a different user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { role: "admin" },
      });
    });

    it("blocks the admin from demoting themselves", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "admin-user-id", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.message).toMatch(/own admin role/i);
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("allows promoting yourself to admin (no-op safety net)", async () => {
      // Even though the admin is already admin, the schema allows the call.
      // We only block demotion of self — promoting yourself is harmless.
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "admin-user-id", role: "admin" });
      expect(res).toEqual({ success: true });
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "missing", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$transaction.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "other-user-id" } });
    });

    it("revokes every MCP token and OAuth connection in the same transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$transaction.mockResolvedValue([]);

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
      // One batch: ban, sessions, tokens, grant, OAuth access, refresh, consent.
      const batch = db.$transaction.mock.calls[0]?.[0] as unknown[];
      expect(batch).toHaveLength(7);
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

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
    });

    it("does not restore the MCP credentials archive revoked", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.unarchive({ userId: "other-user-id" });

      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
      expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
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

    it("cleans up private repositories before cascading the user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
      await createRouterClient(usersRouter, { context: buildContext() }).remove({
        userId: "other-user-id",
      });
      expect(runStop).toHaveBeenCalledExactlyOnceWith("other-user-id");
      expect(deleteRepo).toHaveBeenCalledWith("private-1", { force: true });
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
      db.repository.findMany.mockResolvedValue([{ id: "private-1" }]);
      await cleanupBeforeUserDeletion("other-user-id");
      expect(deleteRepo).toHaveBeenCalledWith("private-1", { force: true });
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
      // Same lifetime as an invite link.
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS);
      // Older reset links and the emailed-invite marker die first.
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: { startsWith: "reset-password:" }, value: "other-user-id" },
      });
      expect(db.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: "invite-email-delivered:other-user-id" },
      });
      expect(db.verification.deleteMany.mock.invocationCallOrder.at(-1)).toBeLessThan(
        createVerificationValue.mock.invocationCallOrder[0]!,
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
      // An un-emailed link records no marker (it proves nothing about the mailbox).
      expect(db.verification.create).not.toHaveBeenCalled();
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
      expect(db.verification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          identifier: "invite-email-delivered:other-user-id",
          value: "alice@example.com",
        }),
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
      expect(db.verification.create).not.toHaveBeenCalled();
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
      const [a, b] = await Promise.all([
        client.passwordLink({ userId: "other-user-id" }),
        client.passwordLink({ userId: "other-user-id" }),
      ]);
      expect(a.emailSent).toBe(false);
      expect(b.emailSent).toBe(false);
      const live = [...rows.keys()].filter((id) => id.startsWith("reset-password:"));
      expect(live).toHaveLength(1);
      expect(createVerificationValue).toHaveBeenCalledTimes(2);
    });
  });
});
