import prisma from "@cockpit-context/db";
import { ADMIN_EMAILS, env, FORCE_SSO, SSO_ENABLED } from "@cockpit-context/env/server";
import {
  isEmailConfigured,
  renderResetPassword,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@cockpit-context/mailer";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import { adminPluginAccess } from "./admin-access.js";
import { revokeBootstrapToken } from "./bootstrap-token.js";
import { verifyInvitedEmailOnPasswordReset } from "./invite-verification.js";
import { resolveMcpPlugins } from "./mcp-plugins.js";
import {
  hasAnyUser,
  invalidateSignupAvailabilityCache,
  isSignupOpen,
} from "./signup-availability.js";
import { TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT } from "./two-factor-policy.js";
import { createUserCreateBeforeHook } from "./user-create-hook.js";
import { cleanupBeforeUserDeletion } from "./user-deletion-hooks.js";
import { withVerificationCallback } from "./verification-callback.js";

const ssoEnabled = SSO_ENABLED;
const forceSso = FORCE_SSO;
const isCrossOrigin = !!env.CORS_ORIGIN;
// Email is optional (docs/product.md). Without SMTP there is no way to
// prove an address, so verification is not required (new rows are created
// verified by the user-create hook below), and the reset/verification senders
// are not registered at all — Better-Auth then refuses those endpoints instead
// of "sending" mail that can never arrive. With SMTP the
// verification flow applies unchanged.
const emailConfigured = isEmailConfigured();

// Better-Auth emits "user input failed validation" cases (wrong password, unknown
// email, unverified email, etc.) at level=error. Those are normal end-user mistakes,
// not server faults — downgrade them to warn so production error dashboards stay
// signal-y. Anything we don't recognize keeps its original level.
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

type SendResetPassword = NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"];

const sendResetPassword: SendResetPassword = async ({ user, url }) => {
  // Same locale-resolution dance as sendVerificationEmail: Better-Auth's
  // callback `user` is typed against the base user shape, so `locale`
  // (an additionalField) isn't on it. Fetch the row via Prisma so the
  // reset email routes through the recipient's preferred locale (the
  // renderer falls back to en-US for any unsupported / missing value).
  //
  // `url` already points at Better-Auth's /api/auth/reset-password/:token
  // endpoint, which validates the token and redirects to the `redirectTo`
  // passed by the client (the web /$lang/reset-password page) with
  // `?token=` appended (or `?error=INVALID_TOKEN` on a bad token).
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { locale: true },
  });
  const { subject, html } = renderResetPassword({
    url,
    locale: row?.locale ?? "en-US",
  });
  await sendEmail({
    to: user.email,
    subject,
    html,
  });
};

const emailVerification: BetterAuthOptions["emailVerification"] = {
  sendVerificationEmail: async ({ user, url }) => {
    // Better-Auth's `additionalFields` are present at runtime but the
    // sendVerificationEmail callback's `user` is typed against the base
    // user shape — `locale` isn't on it. Fetch the row via Prisma so the
    // recipient's preferred locale routes through to the renderer (which
    // falls back to en-US for any unsupported / missing value).
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { locale: true },
    });
    const { subject, html } = renderVerifyEmail({
      // `url` points at Better-Auth's /api/auth/verify-email endpoint, which
      // validates the token and then redirects to the `callbackURL` query
      // param — defaulting to `/` if nobody sets one. Rewrite it here (rather
      // than at each call site) so every verification email, whatever
      // triggered it, lands on the web /$lang/verify-email page with either a
      // confirmation or Better-Auth's `?error=` code.
      // CORS_ORIGIN is the web app's origin when it is served from a
      // different host than this API. Passing it makes the callback absolute
      // so the emailed link lands on the app, not on the API hostname.
      url: withVerificationCallback(url, row?.locale, env.CORS_ORIGIN),
      locale: row?.locale ?? "en-US",
    });
    await sendEmail({
      to: user.email,
      subject,
      html,
    });
  },
  sendOnSignUp: true,
  // `requireEmailVerification` (on whenever this block is registered) rejects
  // a correct password on an unverified account. Without this, that rejection is a dead end: the
  // original link expires after an hour and nothing re-sends it. The login
  // form additionally links to /$lang/verify-email for the case where the
  // re-sent mail doesn't arrive either.
  sendOnSignIn: true,
};

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  logger: {
    log(level, message, ...args) {
      const effective =
        level === "error" && USER_INPUT_ERROR_PATTERN.test(message) ? "warn" : level;
      if (effective === "error") console.error(`[auth] ${message}`, ...args);
      else if (effective === "warn") console.warn(`[auth] ${message}`, ...args);
      else if (effective === "info") console.info(`[auth] ${message}`, ...args);
    },
  },

  trustedOrigins: isCrossOrigin ? [env.CORS_ORIGIN!, env.BETTER_AUTH_URL] : [env.BETTER_AUTH_URL],
  user: {
    additionalFields: {
      // Surface the Prisma `User.locale` column on the typed session so the
      // web app can read `session.user.locale` (and the i18n hook can sync it
      // into i18next). Default mirrors the Prisma `@default("en-US")` so a
      // user who hasn't picked a locale reads as en-US.
      locale: {
        type: "string",
        required: false,
        defaultValue: "en-US",
        input: false, // not settable via signUp/updateUser; goes through the dedicated procedure
      },
      operationalAlerts: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: !forceSso,
    requireEmailVerification: emailConfigured,
    // Better-Auth's default floor is 8. There is no breached-password check in
    // this application, so length is the only guessing cost. The signup and
    // reset-password forms mirror this; the login form deliberately does not,
    // since an account created under an older policy must still be able to
    // authenticate.
    minPasswordLength: 12,
    ...(emailConfigured ? { sendResetPassword } : {}),
    // An emailed invite's set-password link proves the invitee controls the
    // address, so using it verifies the email (./invite-verification.ts).
    // This runs after the password is committed, so a failure here must not
    // fail the reset: the invitee falls back to the normal verification email.
    onPasswordReset: async ({ user }) => {
      try {
        await verifyInvitedEmailOnPasswordReset(user);
      } catch (err) {
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.error("[auth] marking an invited email verified failed:", errLabel);
      }
    },
  },
  ...(emailConfigured ? { emailVerification } : {}),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  session: {
    // session:30d, refresh every 1d
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // Short-lived signed cookie cache: skips the session DB lookup on most
    // requests; revocations/role changes propagate within 60s.
    cookieCache: {
      enabled: true,
      maxAge: 60,
    },
  },
  advanced: {
    cookiePrefix: "cockpit-context",
    defaultCookieAttributes: isCrossOrigin
      ? { sameSite: "none", secure: true, httpOnly: true }
      : { httpOnly: true, secure: env.NODE_ENV === "production" },
  },
  // Better-Auth ships its own rate limiter, enabled by default in production
  // only. We turn it OFF and rely on the limiters in
  // `apps/server/src/rate-limit.ts`, which cover the same routes. This is a
  // consolidation, not a removal — see docs/development.md.
  //
  // Why: the built-in limiter defaults to `storage: "memory"` and keys on
  // `${ip}|${path}`. Two problems compound in a real deployment.
  //   1. Memory storage is per-process, so the effective limit multiplies by
  //      replica count and resets on every deploy.
  //   2. Its IP resolution returns null when `X-Forwarded-For` carries more
  //      than one entry and no `trustedProxies` is configured — the normal
  //      case behind Render or any two-hop proxy. The key then degenerates to
  //      the literal string "no-trusted-ip", SHARED BY EVERY CLIENT. Its
  //      built-in rule of 3 sign-ins per 10s would then apply to the whole
  //      deployment at once: a self-inflicted outage that is also no defense,
  //      announced by a single startup warning.
  // The limiters in apps/server are in-memory too (Cockpit Context runs exactly one app
  // replica — docs/hosting.md), but key on the app's own proxy-aware
  // `resolveClientIp`, one bucket per surface, and are tunable via
  // RATE_LIMIT_* env vars. Running both would double-count
  // and make 429s impossible to attribute.
  //
  // If you re-enable this, configure `advanced.ipAddress.trustedProxies` AND
  // a `secondaryStorage` first — the defaults are not safe behind a proxy.
  rateLimit: { enabled: false },
  plugins: [
    admin({
      defaultRole: "user",
      // No impersonation, admin password/email resets or session listing:
      // admins cannot act as another user (docs/access-matrix.md).
      ...adminPluginAccess,
    }),
    twoFactor({
      issuer: "Cockpit Context",
      // SSO-only users have no credential password to confirm. Better Auth
      // still requires a password whenever a credential account exists, so
      // this lets an authenticated SSO session enroll without weakening the
      // password-confirmation boundary for email/password accounts.
      allowPasswordless: TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT,
      // Email OTP as a second factor — only wired when SMTP is configured.
      // TOTP + backup codes always remain available regardless.
      //
      // Caveat (documented, mitigated elsewhere): Better-Auth's send-otp
      // endpoint catches a thrown/rejected sendOTP and still returns
      // { status: true } (otp/index.ts) — it will NOT surface an SMTP failure to
      // the caller. The login challenge therefore preflights SMTP reachability
      // via `auth.verifyEmailTransport` (→ mailer `verifyTransport()`) before
      // claiming a code was sent. Here we just do the real send and let a
      // failure throw so it is logged server-side.
      ...(emailConfigured
        ? {
            otpOptions: {
              // Hash codes at rest rather than storing them in plaintext
              // (Better-Auth's default).
              storeOTP: "hashed" as const,
              sendOTP: async ({
                user,
                otp,
              }: {
                user: { id: string; email: string };
                otp: string;
              }) => {
                // additionalFields like `locale` aren't on the callback's typed
                // user shape — fetch the row so the code email is localized
                // (renderer falls back to en-US for missing/unsupported values).
                const row = await prisma.user.findUnique({
                  where: { id: user.id },
                  select: { locale: true },
                });
                const { subject, html } = renderTwoFactorOtp({
                  otp,
                  locale: row?.locale ?? "en-US",
                });
                await sendEmail({ to: user.email, subject, html });
              },
            },
          }
        : {}),
    }),
    // MCP OAuth (docs/mcp.md): the OAuth provider, JWT signing, the
    // consent page's propose/auto-approve flags and CIMD clients. Bearer
    // credentials are accepted only on /mcp (apps/server/src/mcp/); the
    // `bearer` plugin is never installed.
    ...resolveMcpPlugins({ baseUrl: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET }),
    ...(ssoEnabled && env.SSO_CLIENT_ID && env.SSO_CLIENT_SECRET && env.SSO_ISSUER
      ? [
          genericOAuth({
            config: [
              {
                providerId: "sso",
                discoveryUrl: `${env.SSO_ISSUER}/.well-known/openid-configuration`,
                clientId: env.SSO_CLIENT_ID,
                clientSecret: env.SSO_CLIENT_SECRET,
                scopes: ["openid", "profile", "email"],
              },
            ],
          }),
        ]
      : []),
  ],
  databaseHooks: {
    user: {
      delete: {
        before: async (user) => {
          await cleanupBeforeUserDeletion(user.id);
        },
        after: async () => {
          invalidateSignupAvailabilityCache();
        },
      },
      update: {
        after: async () => {
          invalidateSignupAvailabilityCache();
        },
      },
      create: {
        before: createUserCreateBeforeHook({
          emailConfigured,
          adminEmails: ADMIN_EMAILS,
          isSignupOpen,
          hasAnyUser: () => hasAnyUser({ fresh: true }),
        }),
        after: async () => {
          // An account exists now: the first-admin bootstrap is closed for
          // good, so the one-time token is spent (./bootstrap-token.ts).
          revokeBootstrapToken();
          invalidateSignupAvailabilityCache();
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
