import { getSignupAvailability } from "@cockpit-context/auth/signup-availability";
import { env, FORCE_SSO, SSO_ENABLED } from "@cockpit-context/env/server";
import { isEmailConfigured } from "@cockpit-context/mailer";
import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { adminBackupsRouter } from "./admin-backups";
import { adminJobsRouter } from "./admin-jobs";
import { adminStorageRouter } from "./admin-storage";
import { authRouter } from "./auth";
import { conversationsRouter } from "./conversations";
import { homeRouter } from "./home";
import { knownHostsRouter } from "./known-hosts";
import { mcpConnectionsRouter } from "./mcp-connections";
import { mcpTokensRouter } from "./mcp-tokens";
import { packagesRouter } from "./packages";
import { proposalsRouter } from "./proposals";
import { repositoriesRouter } from "./repositories";
import { seedRouter } from "./seed";
import { settingsRouter } from "./settings";
import { sshKeysRouter } from "./ssh-keys";
import { usersRouter } from "./users";

export const appRouter = {
  health: {
    // No RPC readiness probe: a DB-touching `ready` procedure would be an
    // anonymous datastore-drain vector bounded only by the generic /rpc
    // limiter. Readiness is the HTTP /ready route, which has its own
    // readyLimiter bucket (apps/server/src/rate-limit.ts).
    check: publicProcedure.handler(() => {
      return "OK";
    }),
  },
  appConfig: publicProcedure.handler(async () => {
    const emailConfigured = isEmailConfigured();
    // Reads are cached in-process (signup-availability.ts), so this public
    // procedure is not a per-call datastore hit.
    const signup = await getSignupAvailability();
    return {
      ssoEnabled: SSO_ENABLED,
      forceSso: FORCE_SSO,
      ssoProviderName: env.SSO_PROVIDER_NAME,
      // Effective open signup: SIGNUP_ENABLED AND the admin's runtime toggle.
      signupOpen: signup.signupOpen,
      // No account exists yet and an ADMIN_EMAILS address holding the boot-log
      // token may create the first (admin) account. Request-independent: it
      // never says WHICH addresses.
      adminBootstrapSignupEnabled: signup.adminBootstrapOpen,
      // Non-null only while no admin exists ("bootstrap" | "configure" |
      // "locked"): what /login and /signup explain to the operator. A server
      // without an admin is unusable, so revealing that state is acceptable.
      adminSetup: signup.adminSetup,
      // Whether SMTP is configured at all. Off → no verification, no password
      // reset, no email OTP (docs/product.md). The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight.
      emailConfigured,
      // Who runs this instance, for the public privacy notice. Operator-chosen
      // public values (COCKPIT_CONTEXT_OPERATOR_*); null when unset. Nothing else about
      // the deployment is published here.
      operator: {
        name: env.COCKPIT_CONTEXT_OPERATOR_NAME ?? null,
        contactEmail: env.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL ?? null,
      },
      // Days of inactivity before a conversation is deleted
      // (COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS; 0 = kept until deleted), stated in
      // the public privacy notice.
      conversationRetentionDays: env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS,
    };
  }),
  adminBackups: adminBackupsRouter,
  adminJobs: adminJobsRouter,
  adminStorage: adminStorageRouter,
  auth: authRouter,
  conversations: conversationsRouter,
  home: homeRouter,
  knownHosts: knownHostsRouter,
  mcpConnections: mcpConnectionsRouter,
  mcpTokens: mcpTokensRouter,
  packages: packagesRouter,
  proposals: proposalsRouter,
  repositories: repositoriesRouter,
  settings: settingsRouter,
  seed: seedRouter,
  sshKeys: sshKeysRouter,
  users: usersRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
