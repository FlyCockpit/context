import type { Session } from "@cockpit-context/auth";
import { TWO_FACTOR_ENROLLMENT_GRACE_MS } from "@cockpit-context/auth/two-factor-policy";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

// `adminProcedure` imports from @cockpit-context/env/server, which validates
// `process.env` at import time. Mock the module so this test doesn't need a
// real .env at resolve time.
vi.mock("@cockpit-context/env/server", () => ({
  env: {},
}));

import type { Context } from "./context";
import {
  adminOr404Procedure,
  adminProcedure,
  authenticatedProcedure,
  checkAdminAuthority,
  checkSessionAccess,
  protectedProcedure,
} from "./index";
import { invalidateForceTwoFactorSettingsCache } from "./lib/two-factor-policy";

const { default: prisma } = await import("@cockpit-context/db");

const db = prisma as unknown as {
  appSetting: {
    findMany: MockInstance;
  };
};

/**
 * Minimal router that uses adminProcedure so we can exercise the middleware
 * chain (requireAuth → requireAdmin) in isolation.
 */
const testRouter = {
  ping: adminProcedure.handler(async () => {
    return { ok: true };
  }),
};

const protectedRouter = {
  ping: protectedProcedure.handler(async () => {
    return { ok: true };
  }),
};

const authenticatedRouter = {
  ping: authenticatedProcedure.handler(async () => {
    return { ok: true };
  }),
};

const testRouter404 = {
  ping: adminOr404Procedure.handler(async () => {
    return { ok: true };
  }),
};

/** Build a minimal oRPC context for testing. */
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
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
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
        userId: sessionOverride?.user?.id ?? "test-user-id",
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

beforeEach(() => {
  vi.clearAllMocks();
  db.appSetting.findMany.mockResolvedValue([]);
  // The force-2FA settings are TTL-cached in-process; drop the cache so each
  // test's appSetting.findMany mock takes effect.
  invalidateForceTwoFactorSettingsCache();
});

describe("protectedProcedure", () => {
  it("throws FORBIDDEN when public-user 2FA is required and the user has no second factor", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);
    const ctx = buildContext({ user: { twoFactorEnabled: false } });
    const client = createRouterClient(protectedRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  it("passes through when public-user 2FA is required and the user has a second factor", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);
    const ctx = buildContext({ user: { twoFactorEnabled: true } });
    const client = createRouterClient(protectedRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });

  // The internal default flipping to ON must not drag public users with it.
  it("leaves an established public user unforced when no setting rows exist", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({ user: { role: "user", twoFactorEnabled: false } });
    const client = createRouterClient(protectedRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });
});

describe("adminProcedure", () => {
  it("throws FORBIDDEN with 'Email verification required' when emailVerified is false", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Email verification required for admin access.");
      return true;
    });
  });

  it("throws FORBIDDEN with 'Admin access required' when role is not admin", async () => {
    const ctx = buildContext({ user: { role: "user", emailVerified: true } });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Admin access required.");
      return true;
    });
  });

  it("passes through to the handler for a verified admin with a second factor", async () => {
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });

  // The absent-row default is ON for internal users (FORCE_2FA_DEFAULTS in
  // @cockpit-context/auth/two-factor-policy). An established admin who never enrolled
  // is rejected without anyone having written the AppSetting row.
  it("throws FORBIDDEN for an established admin without 2FA when the setting row is absent", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  it("admits a brand-new admin without 2FA while the enrollment grace window is open", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({
      user: {
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });

  it("throws FORBIDDEN once the enrollment grace window has closed", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({
      user: {
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - (TWO_FACTOR_ENROLLMENT_GRACE_MS + 60_000)),
      },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  // The grace window covers the forced-2FA check only — never email
  // verification, never the role check.
  it("does not grace an unverified brand-new admin", async () => {
    const ctx = buildContext({
      user: {
        role: "admin",
        emailVerified: false,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.message).toBe("Email verification required for admin access.");
      return true;
    });
  });

  it("throws FORBIDDEN when admin 2FA is required and the admin has no second factor", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  it("admits an unenrolled admin when internal enforcement is explicitly disabled", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "false" }]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });

  it("does not apply the public-user 2FA setting to admins", async () => {
    db.appSetting.findMany.mockResolvedValue([
      { key: "force2faPublicUsers", value: "true" },
      { key: "force2faInternalUsers", value: "false" },
    ]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });

  it("passes through to the handler when admin appears in a comma-separated role list", async () => {
    const ctx = buildContext({
      user: { role: "editor, admin, billing", emailVerified: true, twoFactorEnabled: true },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });
});

describe("adminOr404Procedure", () => {
  it("throws NOT_FOUND when no session is provided", async () => {
    const ctx = buildContext(null);
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("throws NOT_FOUND when emailVerified is false", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("throws NOT_FOUND when role is not admin", async () => {
    const ctx = buildContext({ user: { role: "user", emailVerified: true } });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("passes through to the handler for a verified admin with a second factor", async () => {
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });

  it("throws NOT_FOUND for an established admin without 2FA when the setting row is absent", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });
  });

  it("admits a brand-new admin without 2FA while the enrollment grace window is open", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const ctx = buildContext({
      user: {
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });

  it("throws NOT_FOUND when admin 2FA is required and the admin has no second factor", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("passes through to the handler when admin appears in a comma-separated role list", async () => {
    const ctx = buildContext({
      user: { role: "editor,admin", emailVerified: true, twoFactorEnabled: true },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });
});

// Companion-CLI credentials (docs/development.md). An API key never went through
// sign-in or 2FA, so admin gates reject it even for a fully verified admin; a
// device-flow session token is an ordinary session and still passes.
describe("admin gates and CLI credentials", () => {
  const verifiedAdmin = () =>
    buildContext({ user: { role: "admin", emailVerified: true, twoFactorEnabled: true } });

  it("adminProcedure rejects an API key with FORBIDDEN", async () => {
    const client = createRouterClient(testRouter, {
      context: { ...verifiedAdmin(), credential: "api-key" },
    });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("API keys cannot be used for admin access.");
      return true;
    });
  });

  it("adminOr404Procedure answers NOT_FOUND to an API key", async () => {
    const client = createRouterClient(testRouter404, {
      context: { ...verifiedAdmin(), credential: "api-key" },
    });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });
  });

  it("admits a verified admin on a device-flow session token", async () => {
    const context = { ...verifiedAdmin(), credential: "session-token" as const };
    await expect(createRouterClient(testRouter, { context }).ping()).resolves.toEqual({ ok: true });
    await expect(createRouterClient(testRouter404, { context }).ping()).resolves.toEqual({
      ok: true,
    });
  });

  it("still lets an API key reach a non-admin protected procedure", async () => {
    const client = createRouterClient(protectedRouter, {
      context: { ...buildContext(), credential: "api-key" },
    });
    await expect(client.ping()).resolves.toEqual({ ok: true });
  });
});

// The single admin rule every admin gate maps (requireAdmin, requireAdminOr404,
// apps/server/src/admin-session-gate.ts). The ORDER is part of the contract:
// each gate's status and message depend on which check fails first.
describe("checkAdminAuthority", () => {
  const session = (user: Partial<Session["user"]>) => {
    const ctx = buildContext({ user });
    if (!ctx.session) throw new Error("expected a session");
    return ctx.session;
  };
  const verifiedAdmin = { role: "admin", emailVerified: true, twoFactorEnabled: true };

  it("admits a verified admin with a second factor and returns the same session", async () => {
    const s = session(verifiedAdmin);
    await expect(checkAdminAuthority(s)).resolves.toEqual({ ok: true, session: s });
    await expect(checkAdminAuthority(s, "session-token")).resolves.toEqual({
      ok: true,
      session: s,
    });
  });

  it("checks session, then ban, then API key, then email, then role, then 2FA", async () => {
    await expect(checkAdminAuthority(null, "api-key")).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    // Every later check also fails here; the earliest one is reported.
    const worst = session({ role: "user", emailVerified: false, twoFactorEnabled: false });
    await expect(
      checkAdminAuthority(session({ ...worst.user, banned: true }), "api-key"),
    ).resolves.toEqual({ ok: false, reason: "banned" });
    await expect(checkAdminAuthority(worst, "api-key")).resolves.toEqual({
      ok: false,
      reason: "api-key",
    });
    await expect(checkAdminAuthority(worst)).resolves.toEqual({ ok: false, reason: "unverified" });
    await expect(
      checkAdminAuthority(session({ role: "user", emailVerified: true, twoFactorEnabled: false })),
    ).resolves.toEqual({ ok: false, reason: "not-admin" });
    await expect(
      checkAdminAuthority(session({ role: "admin", emailVerified: true, twoFactorEnabled: false })),
    ).resolves.toEqual({ ok: false, reason: "two-factor" });
  });

  it("maps the earliest failure to requireAdmin's message", async () => {
    const ctx = buildContext({ user: { role: "user", emailVerified: false } });
    await expect(
      createRouterClient(testRouter, { context: { ...ctx, credential: "api-key" } }).ping(),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("API keys cannot be used for admin access.");
      return true;
    });
  });

  it("refuses a banned admin, permanent or with a future expiry, from a cache-hit string too", async () => {
    const future = new Date(Date.now() + 60_000);
    // A Better-Auth cookie-cache hit revives `banExpires` as an ISO string.
    const revivedFromCache = future.toISOString() as unknown as Date;
    for (const banExpires of [null, future, revivedFromCache]) {
      const s = session({ ...verifiedAdmin, banned: true, banExpires });
      await expect(checkAdminAuthority(s), String(banExpires)).resolves.toEqual({
        ok: false,
        reason: "banned",
      });
    }
  });

  it("admits an admin whose temporary ban has lapsed", async () => {
    const s = session({ ...verifiedAdmin, banned: true, banExpires: new Date(Date.now() - 1000) });
    await expect(checkAdminAuthority(s)).resolves.toEqual({ ok: true, session: s });
  });

  it("every oRPC admin gate refuses a banned admin", async () => {
    const ctx = buildContext({ user: { ...verifiedAdmin, banned: true, banExpires: null } });
    await expect(createRouterClient(testRouter, { context: ctx }).ping()).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      },
    );
    await expect(createRouterClient(testRouter404, { context: ctx }).ping()).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
  });

  it("requireAdmin answers UNAUTHORIZED to a missing session", async () => {
    await expect(
      createRouterClient(testRouter, { context: buildContext(null) }).ping(),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("UNAUTHORIZED");
      return true;
    });
  });
});

// A ban ends access to every authenticated procedure, not only the admin ones.
// The admin plugin refuses a banned user only when a session is created, so a
// session issued before the ban keeps resolving through `getSession`; the
// shared `checkSessionAccess` is what refuses it on every request.
describe("banned users on every authenticated procedure", () => {
  const future = () => new Date(Date.now() + 60_000);
  // A Better-Auth cookie-cache hit revives `banExpires` as an ISO string.
  const bans = () => [
    { label: "permanent", banExpires: null },
    { label: "future expiry", banExpires: future() },
    { label: "cache-hit string", banExpires: future().toISOString() as unknown as Date },
  ];
  const routers = [
    ["authenticatedProcedure", authenticatedRouter],
    ["protectedProcedure", protectedRouter],
    ["adminProcedure", testRouter],
  ] as const;

  it("checkSessionAccess refuses a missing session, then a ban, and admits anyone else", () => {
    expect(checkSessionAccess(null)).toEqual({ ok: false, reason: "unauthenticated" });
    expect(checkSessionAccess(undefined)).toEqual({ ok: false, reason: "unauthenticated" });
    for (const { label, banExpires } of bans()) {
      const ctx = buildContext({ user: { banned: true, banExpires } });
      expect(checkSessionAccess(ctx.session), label).toEqual({ ok: false, reason: "banned" });
    }
    const ok = buildContext();
    expect(checkSessionAccess(ok.session)).toEqual({ ok: true, session: ok.session });
  });

  it("answers UNAUTHORIZED from every authenticated builder to a banned user", async () => {
    for (const [name, router] of routers) {
      for (const { label, banExpires } of bans()) {
        const ctx = buildContext({
          user: {
            role: "admin",
            emailVerified: true,
            twoFactorEnabled: true,
            banned: true,
            banExpires,
          },
        });
        await expect(
          createRouterClient(router, { context: ctx }).ping(),
          `${name} / ${label}`,
        ).rejects.toSatisfy((error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("UNAUTHORIZED");
          return true;
        });
      }
    }
  });

  it("refuses a banned user on an API key or device-flow credential too", async () => {
    for (const credential of ["api-key", "session-token"] as const) {
      const ctx = { ...buildContext({ user: { banned: true, banExpires: null } }), credential };
      await expect(
        createRouterClient(protectedRouter, { context: ctx }).ping(),
        credential,
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    }
  });

  it("admits a user whose temporary ban has lapsed", async () => {
    const ctx = buildContext({ user: { banned: true, banExpires: new Date(Date.now() - 1000) } });
    for (const [name, router] of routers.slice(0, 2)) {
      await expect(createRouterClient(router, { context: ctx }).ping(), name).resolves.toEqual({
        ok: true,
      });
    }
  });

  it("refuses an existing session once its user is banned later", async () => {
    // One session row, issued before the ban. Each request resolves it afresh
    // (the context is built per request), and after the ban `getSession`
    // returns the same session with the user now banned; nothing deleted it.
    const issuedAt = new Date(Date.now() - 3_600_000);
    let banned = false;
    const resolveRequestContext = (): Context =>
      buildContext({
        user: { banned, banExpires: null },
        session: { id: "pre-ban-session", createdAt: issuedAt, updatedAt: issuedAt },
      });

    for (const [name, router] of routers.slice(0, 2)) {
      banned = false;
      await expect(
        createRouterClient(router, { context: resolveRequestContext }).ping(),
        `${name} before the ban`,
      ).resolves.toEqual({ ok: true });

      banned = true;
      const client = createRouterClient(router, { context: resolveRequestContext });
      await expect(client.ping(), `${name} after the ban`).rejects.toSatisfy((error: ORPCError) => {
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    }
  });
});
