import {
  hasAnyAdmin,
  invalidateSignupAvailabilityCache,
} from "@cockpit-context/auth/signup-availability";
import { SIGNUP_OPEN_SETTING_KEY } from "@cockpit-context/auth/signup-policy";
import prisma from "@cockpit-context/db";
import { backupMonitorConfigWarnings } from "@cockpit-context/env/backup-config";
import {
  ADMIN_EMAILS,
  COCKPIT_CONTEXT_HELPER_MODEL,
  env,
  SIGNUP_ENABLED,
} from "@cockpit-context/env/server";
import { isEmailConfigured } from "@cockpit-context/mailer";
import { getLspStatus } from "@cockpit-context/runs";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { adminOr404Procedure, authenticatedProcedure } from "../index";
import { cockpitContextRateBudgets } from "../lib/rate-budgets";
import {
  FORCE_2FA_SETTING_KEYS,
  invalidateForceTwoFactorSettingsCache,
} from "../lib/two-factor-policy";

const WRITABLE_SETTING_KEYS = [...FORCE_2FA_SETTING_KEYS, SIGNUP_OPEN_SETTING_KEY] as const;
// Leak-prevention boundary: only keys listed here are exposed to clients via getAll; future settings must be explicitly opted in.
// `signupOpen` is not sensitive: `appConfig` already publishes the effective value.
const CLIENT_READABLE_SETTING_KEYS: readonly string[] = WRITABLE_SETTING_KEYS;
const writableSettingKeySchema = z.enum(WRITABLE_SETTING_KEYS);
const forceTwoFactorKeys: readonly string[] = FORCE_2FA_SETTING_KEYS;

/**
 * Off-site backups are configured in this server's environment: enabled, a
 * bucket, the dump-writer pair (the app leads schema, so it takes the
 * pre-apply dump) and a usable, distinct monitor pair for the freshness check.
 * It cannot see whether the `db-backup` container runs; the backup status card
 * on the admin overview reports whether dumps actually arrive.
 */
function backupsConfigured(): boolean {
  return (
    env.BACKUP_ENABLED &&
    Boolean(env.BACKUP_S3_BUCKET) &&
    Boolean(env.BACKUP_S3_ACCESS_KEY_ID) &&
    Boolean(env.BACKUP_S3_SECRET_ACCESS_KEY) &&
    backupMonitorConfigWarnings(env).length === 0
  );
}

export const settingsRouter = {
  getAll: authenticatedProcedure.handler(async () => {
    const settings = await prisma.appSetting.findMany({
      where: { key: { in: [...CLIENT_READABLE_SETTING_KEYS] } },
      // pagination:audited — bounded by the compile-time settings key list
      take: CLIENT_READABLE_SETTING_KEYS.length,
      select: { key: true, value: true },
    });
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }),

  /**
   * Returns admin-setup status so the client can render a prominent warning
   * banner when ADMIN_EMAILS is empty (no users will ever be granted admin
   * privileges). Authenticated so the banner only shows to logged-in users.
   */
  adminSetupStatus: authenticatedProcedure.handler(async () => {
    return {
      needsAdmin: !(await hasAnyAdmin()),
      adminEmailsEmpty: ADMIN_EMAILS.size === 0,
      // The env ceiling for the signup toggle: when false, the admin settings
      // page explains that `signupOpen` cannot open signup.
      signupEnvEnabled: SIGNUP_ENABLED,
    };
  }),

  /**
   * The effective server configuration for the admin settings page
   * (docs/product.md): the `COCKPIT_CONTEXT_*` limits, rate budgets and
   * model names after defaults, whether OpenRouter, SMTP and backups are configured, the
   * conversation retention period, the operator identity, and whether the
   * LSP tools are offered (the language-server sandbox, COCKPIT_CONTEXT_LSP_SANDBOX).
   * Booleans only for anything secret — never a key, password, bucket, host or
   * base URL.
   */
  runtimeConfig: adminOr404Procedure.handler(() => {
    const lsp = getLspStatus();
    return {
      signupEnvEnabled: SIGNUP_ENABLED,
      openRouter: {
        apiKeyConfigured: Boolean(env.OPENROUTER_API_KEY),
        /** COCKPIT_CONTEXT_MODEL_API: the API the agent speaks (chat-completions, responses, messages). */
        api: env.COCKPIT_CONTEXT_MODEL_API,
        /** COCKPIT_CONTEXT_OPENROUTER_BASE_URL is set (the development fake or a gateway). */
        customEndpoint: Boolean(env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL),
        model: env.COCKPIT_CONTEXT_MODEL ?? null,
        /** COCKPIT_CONTEXT_HELPER_MODEL, falling back to COCKPIT_CONTEXT_MODEL. */
        helperModel: COCKPIT_CONTEXT_HELPER_MODEL ?? null,
      },
      emailConfigured: isEmailConfigured(),
      backupsConfigured: backupsConfigured(),
      /** Days after last activity before a conversation is deleted; 0 = kept until deleted. */
      conversationRetentionDays: env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS,
      /** COCKPIT_CONTEXT_OPERATOR_*: public values already published by `appConfig`. */
      operator: {
        name: env.COCKPIT_CONTEXT_OPERATOR_NAME ?? null,
        contactEmail: env.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL ?? null,
      },
      limits: {
        maxStorageGb: env.COCKPIT_CONTEXT_MAX_STORAGE_GB,
        maxIterations: env.COCKPIT_CONTEXT_MAX_ITERATIONS,
        runTimeoutSeconds: env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS,
        modelStallSeconds: env.COCKPIT_CONTEXT_MODEL_STALL_SECONDS,
        maxConcurrentRuns: env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS,
        maxConcurrentRunsPerUser: env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER,
        mcpWaitSeconds: env.COCKPIT_CONTEXT_MCP_WAIT_SECONDS,
        fetchIntervalSeconds: env.COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS,
        lspIdleSeconds: env.COCKPIT_CONTEXT_LSP_IDLE_SECONDS,
        lspMaxServers: env.COCKPIT_CONTEXT_LSP_MAX_SERVERS,
        maxMcpResultWaitsPerUser: env.COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER,
        maxLiveStreamsPerUser: env.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER,
        maxPendingProposalsPerUser: env.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER,
      },
      /**
       * Every Cockpit Context rate budget after defaults (`COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW>`):
       * the count from env, the fixed window, and who one bucket belongs to.
       */
      rateLimits: cockpitContextRateBudgets(),
      /**
       * The language servers: `setting` is COCKPIT_CONTEXT_LSP_SANDBOX, `sandbox` what the
       * Landlock probe found (`landlock` with the kernel's ABI and which
       * protections are active; `unavailable` carries the helper's own message,
       * which names no secret), `enabled` whether the agent gets the LSP tools.
       */
      lsp: {
        enabled: lsp.enabled,
        setting: env.COCKPIT_CONTEXT_LSP_SANDBOX,
        sandbox: lsp.sandbox,
      },
    };
  }),

  myNotificationPreferences: authenticatedProcedure.handler(async ({ context }) => {
    const user = await prisma.user.findUnique({
      where: { id: context.session.user.id },
      select: { operationalAlerts: true },
    });
    return {
      operationalAlerts: user?.operationalAlerts ?? true,
    };
  }),

  updateMyNotificationPreferences: authenticatedProcedure
    .input(
      z.object({
        operationalAlerts: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      await prisma.user.update({
        where: { id: context.session.user.id },
        data: { operationalAlerts: input.operationalAlerts },
      });
      return { success: true };
    }),

  update: adminOr404Procedure
    .input(
      z.object({
        key: writableSettingKeySchema,
        value: z.enum(["true", "false"]),
      }),
    )
    .handler(async ({ input, context }) => {
      const isForceTwoFactorKey = forceTwoFactorKeys.includes(input.key);
      // Strict by design: an admin must secure their own account before
      // requiring 2FA for either public users or internal/admin users.
      if (isForceTwoFactorKey && input.value === "true") {
        if (!context.session.user.twoFactorEnabled) {
          throw new ORPCError("FORBIDDEN", {
            message: "You must enable 2FA for your own account before requiring it for others",
          });
        }
      }

      await prisma.appSetting.upsert({
        where: { key: input.key },
        update: { value: input.value },
        create: { key: input.key, value: input.value },
      });
      // `signupOpen` is ANDed with SIGNUP_ENABLED at read time, so writing
      // "true" while the env flag is off is harmless: signup stays closed.
      if (isForceTwoFactorKey) invalidateForceTwoFactorSettingsCache();
      else invalidateSignupAvailabilityCache();

      return { success: true };
    }),
};
