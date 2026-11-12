import type { Session } from "@cockpit-context/auth";
import { cockpitContextRateBudgetEnvDefaults } from "@cockpit-context/env/rate-budgets";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { settingsRouter } from "./settings";

// Mock @cockpit-context/db before importing the module
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

// Mock @cockpit-context/env/server so settings.ts (ADMIN_EMAILS) and adminOr404Procedure
// (via index.ts) can load without a real .env.
const envFlags = vi.hoisted(() => ({ SIGNUP_ENABLED: false }));
const mockEnv = vi.hoisted(() => ({}) as Record<string, unknown>);
const helperModel = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("@cockpit-context/env/server", () => ({
  env: mockEnv,
  ADMIN_EMAILS: new Set<string>(),
  get SIGNUP_ENABLED() {
    return envFlags.SIGNUP_ENABLED;
  },
  get COCKPIT_CONTEXT_HELPER_MODEL() {
    return helperModel.value;
  },
}));

const mailer = vi.hoisted(() => ({ configured: false }));
vi.mock("@cockpit-context/mailer", () => ({ isEmailConfigured: () => mailer.configured }));

type LspStatus = ReturnType<typeof import("@cockpit-context/runs").getLspStatus>;
const SANDBOXED: LspStatus = {
  enabled: true,
  maxServers: 4,
  sandbox: {
    mode: "landlock",
    abi: 8,
    tcp: true,
    scoping: true,
    checkedAt: "2026-10-26T09:00:00.000Z",
  },
};
const lspStatus = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("@cockpit-context/runs", () => ({ getLspStatus: () => lspStatus.value }));

/** The schema defaults (packages/env/src/vars/server.ts) for the COCKPIT_CONTEXT_* limits. */
const DEFAULT_LIMITS = {
  COCKPIT_CONTEXT_MODEL_API: "chat-completions",
  COCKPIT_CONTEXT_MAX_STORAGE_GB: 20,
  COCKPIT_CONTEXT_MAX_ITERATIONS: 100,
  COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS: 600,
  COCKPIT_CONTEXT_MODEL_STALL_SECONDS: 90,
  COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS: 4,
  COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER: 3,
  COCKPIT_CONTEXT_MCP_WAIT_SECONDS: 900,
  ...cockpitContextRateBudgetEnvDefaults(),
  COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS: 300,
  COCKPIT_CONTEXT_LSP_IDLE_SECONDS: 30,
  COCKPIT_CONTEXT_LSP_MAX_SERVERS: 4,
  COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER: 10,
  COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER: 20,
  COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER: 100,
  COCKPIT_CONTEXT_LSP_SANDBOX: "required",
  COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90,
};

/** A complete backup configuration, as compose passes it to the app. */
const COMPLETE_BACKUP_ENV = {
  BACKUP_ENABLED: true,
  BACKUP_S3_BUCKET: "cockpit-context-backups-bucket-name",
  BACKUP_S3_ACCESS_KEY_ID: "writer-key-id",
  BACKUP_S3_SECRET_ACCESS_KEY: "writer-secret-value",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "monitor-key-id",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "monitor-secret-value",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_ENDPOINT: "https://account.r2.cloudflarestorage.example",
};

// Re-import the mocked module so we can configure return values
const { default: prisma } = await import("@cockpit-context/db");

// Re-import the mocked ADMIN_EMAILS Set so tests can mutate it. Both settings.ts
// and this file receive the same Set instance from the vi.mock factory above.
const { ADMIN_EMAILS: mockAdminEmails } = (await import("@cockpit-context/env/server")) as {
  ADMIN_EMAILS: Set<string>;
};

const { isSignupOpen, invalidateSignupAvailabilityCache } = await import(
  "@cockpit-context/auth/signup-availability"
);

// Type-safe handle to the mocked Prisma methods
const db = prisma as unknown as {
  appSetting: {
    findMany: MockInstance;
    findUnique: MockInstance;
    upsert: MockInstance;
  };
  user: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
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

describe("settingsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findMany.mockResolvedValue([]);
    mockAdminEmails.clear();
    envFlags.SIGNUP_ENABLED = false;
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    // BACKUP_ENABLED defaults to true in the schema (packages/env/src/vars/shared.ts).
    Object.assign(mockEnv, DEFAULT_LIMITS, { BACKUP_ENABLED: true });
    helperModel.value = undefined;
    mailer.configured = false;
    lspStatus.value = SANDBOXED;
    invalidateSignupAvailabilityCache();
  });

  describe("runtimeConfig", () => {
    const admin = () => buildContext({ user: { role: "admin", twoFactorEnabled: true } });

    it("returns the effective limits and model names", async () => {
      Object.assign(mockEnv, {
        OPENROUTER_API_KEY: "sk-or-secret-value",
        COCKPIT_CONTEXT_MODEL: "vendor/main-model",
        COCKPIT_CONTEXT_MODEL_API: "responses",
        COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "http://127.0.0.1:4010/api/v1",
        COCKPIT_CONTEXT_MAX_ITERATIONS: 42,
      });
      helperModel.value = "vendor/helper-model";
      mailer.configured = true;
      envFlags.SIGNUP_ENABLED = true;
      const client = createRouterClient(settingsRouter, { context: admin() });

      await expect(client.runtimeConfig()).resolves.toEqual({
        signupEnvEnabled: true,
        openRouter: {
          apiKeyConfigured: true,
          api: "responses",
          customEndpoint: true,
          model: "vendor/main-model",
          helperModel: "vendor/helper-model",
        },
        emailConfigured: true,
        backupsConfigured: false,
        conversationRetentionDays: 90,
        operator: { name: null, contactEmail: null },
        limits: {
          maxStorageGb: 20,
          maxIterations: 42,
          runTimeoutSeconds: 600,
          modelStallSeconds: 90,
          maxConcurrentRuns: 4,
          maxConcurrentRunsPerUser: 3,
          mcpWaitSeconds: 900,
          fetchIntervalSeconds: 300,
          lspIdleSeconds: 30,
          lspMaxServers: 4,
          maxMcpResultWaitsPerUser: 10,
          maxLiveStreamsPerUser: 20,
          maxPendingProposalsPerUser: 100,
        },
        rateLimits: expect.any(Array),
        lsp: {
          enabled: true,
          setting: "required",
          sandbox: {
            mode: "landlock",
            abi: 8,
            tcp: true,
            scoping: true,
            checkedAt: "2026-10-26T09:00:00.000Z",
          },
        },
      });
    });

    it("lists every Cockpit Context rate budget at its default, and an override as set", async () => {
      Object.assign(mockEnv, { COCKPIT_CONTEXT_RUNS_PER_HOUR: 7 });
      const client = createRouterClient(settingsRouter, { context: admin() });
      const { rateLimits } = await client.runtimeConfig();

      expect(rateLimits).toHaveLength(16);
      expect(rateLimits[0]).toEqual({
        id: "conversationRun",
        envKey: "COCKPIT_CONTEXT_RUNS_PER_HOUR",
        points: 7,
        windowSeconds: 3600,
        keyedOn: "user",
      });
      expect(rateLimits).toContainEqual({
        id: "mcpRegistration",
        envKey: "COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR",
        points: 60,
        windowSeconds: 3600,
        keyedOn: "service",
      });
      // The consent bucket is the signed-in user, falling back to the IP.
      expect(rateLimits).toContainEqual(
        expect.objectContaining({ id: "mcpConsent", keyedOn: "user-or-ip" }),
      );
      // Names and numbers only: nothing secret travels in this list.
      for (const budget of rateLimits) {
        expect(Object.keys(budget).sort()).toEqual(
          ["envKey", "id", "keyedOn", "points", "windowSeconds"].sort(),
        );
      }
    });

    it("reports a required sandbox the kernel cannot enforce, with its reason", async () => {
      const unavailable: LspStatus = {
        enabled: false,
        maxServers: 4,
        sandbox: {
          mode: "unavailable",
          reason: "unsupported",
          detail:
            "Landlock is not enabled on this kernel (add landlock to the lsm= boot parameter)",
          checkedAt: "2026-10-26T09:00:00.000Z",
        },
      };
      lspStatus.value = unavailable;
      const client = createRouterClient(settingsRouter, { context: admin() });
      await expect(client.runtimeConfig()).resolves.toMatchObject({
        lsp: { enabled: false, setting: "required", sandbox: unavailable.sandbox },
      });
    });

    it.each([
      {
        mode: "unavailable",
        reason: "failed",
        detail: "the helper did not finish within 15 s",
        checkedAt: "2026-10-26T09:00:00.000Z",
        retryAt: "2026-10-26T09:00:30.000Z",
      },
      { mode: "probing", since: "2026-10-26T09:00:00.000Z" },
    ] as const)("reports the probe's state and times as they are ($mode)", async (sandbox) => {
      lspStatus.value = { enabled: false, maxServers: 4, sandbox } satisfies LspStatus;
      const client = createRouterClient(settingsRouter, { context: admin() });
      await expect(client.runtimeConfig()).resolves.toMatchObject({
        lsp: { enabled: false, setting: "required", sandbox },
      });
    });

    it("never returns a secret or the endpoint URL", async () => {
      Object.assign(mockEnv, {
        OPENROUTER_API_KEY: "sk-or-secret-value",
        COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "https://user:pass@proxy.example/api/v1",
        SMTP_PASS: "smtp-secret",
        COCKPIT_CONTEXT_ENCRYPTION_KEYS: "v1:c2VjcmV0",
        ...COMPLETE_BACKUP_ENV,
      });
      const client = createRouterClient(settingsRouter, { context: admin() });

      const serialized = JSON.stringify(await client.runtimeConfig());
      expect(serialized).not.toContain("sk-or-secret-value");
      expect(serialized).not.toContain("proxy.example");
      expect(serialized).not.toContain("smtp-secret");
      expect(serialized).not.toContain("c2VjcmV0");
      for (const value of Object.values(COMPLETE_BACKUP_ENV)) {
        if (typeof value === "string") expect(serialized).not.toContain(value);
      }
    });

    it("reports backups configured only with a bucket, the writer pair and a distinct monitor pair", async () => {
      const client = createRouterClient(settingsRouter, { context: admin() });
      const configured = async () => (await client.runtimeConfig()).backupsConfigured;

      Object.assign(mockEnv, COMPLETE_BACKUP_ENV);
      await expect(configured()).resolves.toBe(true);

      for (const missing of [
        "BACKUP_S3_BUCKET",
        "BACKUP_S3_ACCESS_KEY_ID",
        "BACKUP_S3_SECRET_ACCESS_KEY",
        "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
        "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
      ]) {
        Object.assign(mockEnv, COMPLETE_BACKUP_ENV);
        delete mockEnv[missing];
        await expect(configured(), missing).resolves.toBe(false);
      }

      Object.assign(mockEnv, COMPLETE_BACKUP_ENV, { BACKUP_ENABLED: false });
      await expect(configured()).resolves.toBe(false);

      // The monitor must not reuse the dump-writer key.
      Object.assign(mockEnv, COMPLETE_BACKUP_ENV, {
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: COMPLETE_BACKUP_ENV.BACKUP_S3_ACCESS_KEY_ID,
      });
      await expect(configured()).resolves.toBe(false);

      // Region "auto" (R2) needs an endpoint.
      Object.assign(mockEnv, COMPLETE_BACKUP_ENV);
      delete mockEnv.BACKUP_S3_ENDPOINT;
      await expect(configured()).resolves.toBe(false);
    });

    it("shows the retention period and the operator identity once set", async () => {
      Object.assign(mockEnv, {
        COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 0,
        COCKPIT_CONTEXT_OPERATOR_NAME: "Example Co.",
        COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL: "privacy@example.com",
      });
      const client = createRouterClient(settingsRouter, { context: admin() });
      await expect(client.runtimeConfig()).resolves.toMatchObject({
        conversationRetentionDays: 0,
        operator: { name: "Example Co.", contactEmail: "privacy@example.com" },
      });
    });

    it("reports a missing key and model as not configured", async () => {
      const client = createRouterClient(settingsRouter, { context: admin() });

      await expect(client.runtimeConfig()).resolves.toMatchObject({
        openRouter: {
          apiKeyConfigured: false,
          customEndpoint: false,
          model: null,
          helperModel: null,
        },
        emailConfigured: false,
        backupsConfigured: false,
      });
    });

    it("is 404-hidden from non-admins and anonymous callers", async () => {
      for (const ctx of [buildContext(), buildContext(null)]) {
        const client = createRouterClient(settingsRouter, { context: ctx });
        await expect(client.runtimeConfig()).rejects.toSatisfy((error: ORPCError) => {
          expect(error.code).toBe("NOT_FOUND");
          return true;
        });
      }
    });
  });

  describe("getAll", () => {
    it("returns allowlisted settings as a key-value map and filters at the DB", async () => {
      db.appSetting.findMany.mockResolvedValue([
        { key: "force2faPublicUsers", value: "false" },
        { key: "force2faInternalUsers", value: "true" },
      ]);

      const ctx = buildContext(); // authenticated user
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({
        force2faPublicUsers: "false",
        force2faInternalUsers: "true",
      });
      expect(db.appSetting.findMany).toHaveBeenCalledOnce();
      // Verify the allowlist is enforced at the query level so non-allowlisted
      // keys (e.g. future secrets/integration flags) never leave the DB.
      const call = db.appSetting.findMany.mock.calls[0]?.[0] as {
        where: { key: { in: string[] } };
      };
      expect(call.where.key.in).toContain("force2faPublicUsers");
      expect(call.where.key.in).toContain("force2faInternalUsers");
      expect(call.where.key.in).not.toContain("siteName");
    });

    it("remains readable when scoped 2FA is enabled and the user has not enrolled yet", async () => {
      db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);

      const ctx = buildContext({ user: { twoFactorEnabled: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).resolves.toEqual({ force2faPublicUsers: "true" });
    });

    it("returns an empty object when no settings exist", async () => {
      db.appSetting.findMany.mockResolvedValue([]);

      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({});
    });

    it("throws UNAUTHORIZED for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });
  });

  describe("myNotificationPreferences", () => {
    it("returns the user's operational alert preference", async () => {
      db.user.findUnique.mockResolvedValue({ operationalAlerts: false });

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: false,
      });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        select: { operationalAlerts: true },
      });
    });

    it("defaults operational alerts on when the row is unavailable", async () => {
      db.user.findUnique.mockResolvedValue(null);

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: true,
      });
    });
  });

  describe("updateMyNotificationPreferences", () => {
    it("updates the user's operational alert preference", async () => {
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(
        client.updateMyNotificationPreferences({ operationalAlerts: false }),
      ).resolves.toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: { operationalAlerts: false },
      });
    });
  });

  describe("adminSetupStatus", () => {
    it("returns adminEmailsEmpty: true when ADMIN_EMAILS is empty", async () => {
      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.adminSetupStatus();

      expect(result).toEqual({ needsAdmin: true, adminEmailsEmpty: true, signupEnvEnabled: false });
    });

    it("returns adminEmailsEmpty: false when ADMIN_EMAILS has entries", async () => {
      mockAdminEmails.add("admin@example.com");

      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.adminSetupStatus();

      expect(result).toEqual({
        needsAdmin: true,
        adminEmailsEmpty: false,
        signupEnvEnabled: false,
      });
    });

    it("reports that an existing admin needs no bootstrap even with no allowlist", async () => {
      db.user.findMany.mockResolvedValue([{ role: "admin" }]);
      const client = createRouterClient(settingsRouter, { context: buildContext() });
      await expect(client.adminSetupStatus()).resolves.toMatchObject({
        needsAdmin: false,
        adminEmailsEmpty: true,
      });
    });

    it("reports the SIGNUP_ENABLED ceiling for the admin signup toggle", async () => {
      envFlags.SIGNUP_ENABLED = true;
      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.adminSetupStatus()).resolves.toMatchObject({ signupEnvEnabled: true });
    });

    it("throws UNAUTHORIZED for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.adminSetupStatus()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });
  });

  describe("update", () => {
    it("upserts the setting and returns success", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "force2faPublicUsers",
        value: "false",
      });

      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.update({
        key: "force2faPublicUsers",
        value: "false",
      });

      expect(result).toEqual({ success: true });
      expect(db.appSetting.upsert).toHaveBeenCalledWith({
        where: { key: "force2faPublicUsers" },
        update: { value: "false" },
        create: { key: "force2faPublicUsers", value: "false" },
      });
    });

    // The escape hatch for an owner who does not want forced admin 2FA: the
    // internal default is on, so turning it off has to be reachable during the
    // enrollment grace window, before the gate starts rejecting them.
    it("lets an admin inside the enrollment grace window turn internal enforcement off", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "force2faInternalUsers",
        value: "false",
      });

      const ctx = buildContext({
        user: { role: "admin", twoFactorEnabled: false, createdAt: new Date(Date.now() - 60_000) },
      });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(
        client.update({ key: "force2faInternalUsers", value: "false" }),
      ).resolves.toEqual({ success: true });
    });

    describe("signupOpen toggle", () => {
      it("lets an admin close signup without the 2FA precondition and takes effect at once", async () => {
        envFlags.SIGNUP_ENABLED = true;
        db.appSetting.findUnique.mockResolvedValue(null);
        await expect(isSignupOpen()).resolves.toBe(true); // primes the cache

        db.appSetting.upsert.mockResolvedValue({ key: "signupOpen", value: "false" });
        db.appSetting.findUnique.mockResolvedValue({ value: "false" });
        // Inside the enrollment grace window, no second factor of their own:
        // the self-2FA rule is for the force-2FA keys only.
        const ctx = buildContext({
          user: {
            role: "admin",
            twoFactorEnabled: false,
            createdAt: new Date(Date.now() - 60_000),
          },
        });
        const client = createRouterClient(settingsRouter, { context: ctx });

        await expect(client.update({ key: "signupOpen", value: "false" })).resolves.toEqual({
          success: true,
        });
        expect(db.appSetting.upsert).toHaveBeenCalledWith({
          where: { key: "signupOpen" },
          update: { value: "false" },
          create: { key: "signupOpen", value: "false" },
        });
        // The write invalidated the cached value: no stale "open" window.
        await expect(isSignupOpen()).resolves.toBe(false);
      });

      it("accepts opening signup, which stays closed while SIGNUP_ENABLED is off", async () => {
        db.appSetting.upsert.mockResolvedValue({ key: "signupOpen", value: "true" });
        const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
        const client = createRouterClient(settingsRouter, { context: ctx });

        await client.update({ key: "signupOpen", value: "true" });
        await expect(isSignupOpen()).resolves.toBe(false);
      });

      it("hides the toggle from non-admins", async () => {
        const ctx = buildContext({ user: { role: "user", twoFactorEnabled: true } });
        const client = createRouterClient(settingsRouter, { context: ctx });

        await expect(client.update({ key: "signupOpen", value: "true" })).rejects.toSatisfy(
          (error: ORPCError) => error.code === "NOT_FOUND",
        );
        expect(db.appSetting.upsert).not.toHaveBeenCalled();
      });
    });

    it("rejects unknown setting keys", async () => {
      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });
      const update = client.update as (input: { key: string; value: string }) => Promise<unknown>;

      await expect(update({ key: "siteName", value: "Nope" })).rejects.toThrow();
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    // Inside the enrollment grace window this admin still gets past
    // `adminOr404Procedure`, so the self-2FA precondition is the check that
    // actually answers — which is what this test is about.
    it("throws FORBIDDEN when enabling scoped 2FA without 2FA on own account", async () => {
      const ctx = buildContext({
        user: { role: "admin", twoFactorEnabled: false, createdAt: new Date(Date.now() - 60_000) },
      });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(
        client.update({ key: "force2faInternalUsers", value: "true" }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("FORBIDDEN");
        expect(error.message).toMatch(/enable 2FA/i);
        return true;
      });

      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("rejects writes to keys outside the writable enum", async () => {
      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });
      const update = client.update as (input: { key: string; value: string }) => Promise<unknown>;

      await expect(update({ key: "siteName", value: "false" })).rejects.toThrow();
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND for non-admin users", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND when admin email is not verified", async () => {
      const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });
});
