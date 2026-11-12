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
import { adminOr404Procedure, adminProcedure, protectedProcedure } from "./index";
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
