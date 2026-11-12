import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — emailConfigured reads SMTP_HOST/SMTP_FROM (via the mailer's
// isEmailConfigured, mocked below against this same object) at call time, so
// flipping them between tests exercises both branches of the flag.
const envMock = {
  SMTP_HOST: undefined as string | undefined,
  SMTP_FROM: undefined as string | undefined,
  SSO_PROVIDER_NAME: "SSO",
  COCKPIT_CONTEXT_OPERATOR_NAME: undefined as string | undefined,
  COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90,
  COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL: undefined as string | undefined,
  SSO_ENABLED: false,
  FORCE_SSO: false,
  SIGNUP_ENABLED: true,
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
};
const adminEmailsMock = new Set<string>();
vi.mock("@cockpit-context/env/server", () => ({
  env: envMock,
  get SSO_ENABLED() {
    return envMock.SSO_ENABLED;
  },
  get FORCE_SSO() {
    return envMock.FORCE_SSO;
  },
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
  ADMIN_EMAILS: adminEmailsMock,
}));

// `@cockpit-context/env/shared` VALIDATES process.env at module load and throws when it
// is empty — which is exactly CI, so importing the full router graph pulls it
// in. Mock every import-time I/O boundary: see docs/development.md.
vi.mock("@cockpit-context/env/shared", () => ({
  env: {},
}));

// Mock @cockpit-context/db so importing the full appRouter graph never touches Postgres.
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// @cockpit-context/auth builds the Better-Auth instance (prismaAdapter, plugins) at
// import time — stub it so the graph loads without that machinery.
vi.mock("@cockpit-context/auth", () => ({
  auth: { api: {} },
}));

// @cockpit-context/mailer would open SMTP — stub the surface the import graph uses.
// isEmailConfigured mirrors the real implementation against the env mock.
vi.mock("@cockpit-context/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
  isEmailConfigured: () => Boolean(envMock.SMTP_HOST && envMock.SMTP_FROM),
}));

const { appRouter } = await import("./index");
const { default: prisma } = await import("@cockpit-context/db");
const { invalidateSignupAvailabilityCache } = await import(
  "@cockpit-context/auth/signup-availability"
);
const { issueBootstrapToken, revokeBootstrapToken } = await import(
  "@cockpit-context/auth/bootstrap-token"
);
const db = prisma as unknown as {
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

const publicContext: Context = { session: null };

describe("health", () => {
  it("exposes only the cheap check — no RPC readiness probe on the datastore", () => {
    // A DB-touching `ready` procedure was removed as an anonymous
    // datastore-drain vector bounded only by the generic /rpc limiter;
    // readiness is the HTTP /ready route with its own readyLimiter bucket.
    expect(Object.keys(appRouter.health)).toEqual(["check"]);
  });

  it("answers check without a session", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });

    await expect(client.health.check()).resolves.toBe("OK");
  });
});

describe("appConfig", () => {
  beforeEach(() => {
    envMock.SMTP_HOST = undefined;
    envMock.SMTP_FROM = undefined;
    envMock.SSO_ENABLED = false;
    envMock.FORCE_SSO = false;
    envMock.SIGNUP_ENABLED = true;
    envMock.SSO_PROVIDER_NAME = "SSO";
    envMock.COCKPIT_CONTEXT_OPERATOR_NAME = undefined;
    envMock.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL = undefined;
    envMock.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 90;
    adminEmailsMock.clear();
    invalidateSignupAvailabilityCache();
    db.appSetting.findUnique.mockReset().mockResolvedValue(null);
    db.user.findMany.mockReset().mockResolvedValue([]);
    db.user.findFirst.mockReset().mockResolvedValue(null);
    revokeBootstrapToken();
  });

  async function appConfig() {
    const client = createRouterClient(appRouter, { context: publicContext });
    return client.appConfig();
  }

  it("reports emailConfigured=false when SMTP_HOST is unset", async () => {
    expect((await appConfig()).emailConfigured).toBe(false);
  });

  it("reports emailConfigured=true when SMTP_HOST and SMTP_FROM are configured", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";
    expect((await appConfig()).emailConfigured).toBe(true);
  });

  it("reports emailConfigured=false when SMTP_HOST is set without SMTP_FROM", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    expect((await appConfig()).emailConfigured).toBe(false);
  });

  it("surfaces the SSO and signup flags alongside emailConfigured", async () => {
    envMock.SSO_ENABLED = true;
    envMock.FORCE_SSO = true;
    envMock.SIGNUP_ENABLED = false;
    envMock.SSO_PROVIDER_NAME = "Okta";
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";

    expect(await appConfig()).toEqual({
      ssoEnabled: true,
      forceSso: true,
      ssoProviderName: "Okta",
      signupOpen: false,
      adminBootstrapSignupEnabled: false,
      adminSetup: "configure",
      emailConfigured: true,
      operator: { name: null, contactEmail: null },
      conversationRetentionDays: 90,
    });
  });

  it("publishes the configured conversation retention, 0 meaning kept until deleted", async () => {
    envMock.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 30;
    expect((await appConfig()).conversationRetentionDays).toBe(30);
    envMock.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 0;
    expect((await appConfig()).conversationRetentionDays).toBe(0);
  });

  it("publishes exactly the operator name and contact address, null when unset", async () => {
    expect((await appConfig()).operator).toEqual({ name: null, contactEmail: null });
    envMock.COCKPIT_CONTEXT_OPERATOR_NAME = "Example Co.";
    envMock.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL = "privacy@example.com";
    expect((await appConfig()).operator).toEqual({
      name: "Example Co.",
      contactEmail: "privacy@example.com",
    });
  });

  describe("signupOpen = SIGNUP_ENABLED AND the signupOpen setting", () => {
    it.each([
      { env: false, setting: null, expected: false },
      { env: false, setting: "true", expected: false },
      { env: true, setting: null, expected: true },
      { env: true, setting: "true", expected: true },
      { env: true, setting: "false", expected: false },
    ])("env=$env setting=$setting → $expected", async ({ env, setting, expected }) => {
      envMock.SIGNUP_ENABLED = env;
      db.appSetting.findUnique.mockResolvedValue(setting === null ? null : { value: setting });
      expect((await appConfig()).signupOpen).toBe(expected);
    });
  });

  describe.each([false, true])("first-admin bootstrap (SMTP configured: %s)", (smtp) => {
    beforeEach(() => {
      envMock.SIGNUP_ENABLED = false;
      if (smtp) {
        envMock.SMTP_HOST = "smtp.example.com";
        envMock.SMTP_FROM = "App <no-reply@example.com>";
      }
    });

    it("is open with an allowlist, no account and a boot-log token", async () => {
      adminEmailsMock.add("admin@example.com");
      issueBootstrapToken();
      expect(await appConfig()).toMatchObject({
        adminBootstrapSignupEnabled: true,
        adminSetup: "bootstrap",
      });
    });

    it("asks to set ADMIN_EMAILS and restart without an allowlist or without a token", async () => {
      issueBootstrapToken();
      expect(await appConfig()).toMatchObject({
        adminBootstrapSignupEnabled: false,
        adminSetup: "configure",
      });
      adminEmailsMock.add("admin@example.com");
      revokeBootstrapToken();
      invalidateSignupAvailabilityCache();
      expect(await appConfig()).toMatchObject({
        adminBootstrapSignupEnabled: false,
        adminSetup: "configure",
      });
    });

    it("closes once any account exists, even a non-admin one", async () => {
      adminEmailsMock.add("admin@example.com");
      issueBootstrapToken();
      db.user.findFirst.mockResolvedValue({ id: "u1" });
      expect(await appConfig()).toMatchObject({
        adminBootstrapSignupEnabled: false,
        adminSetup: "locked",
      });
    });

    it("says nothing about setup once an admin exists", async () => {
      adminEmailsMock.add("admin@example.com");
      db.user.findMany.mockResolvedValue([{ role: "admin" }]);
      db.user.findFirst.mockResolvedValue({ id: "u1" });
      expect(await appConfig()).toMatchObject({
        adminBootstrapSignupEnabled: false,
        adminSetup: null,
      });
    });
  });

  it("offers the bootstrap even while open signup is on (the first listed address becomes admin)", async () => {
    adminEmailsMock.add("admin@example.com");
    issueBootstrapToken();
    expect(await appConfig()).toMatchObject({
      signupOpen: true,
      adminBootstrapSignupEnabled: true,
    });
  });
});
