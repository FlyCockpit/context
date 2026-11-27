import prisma from "@cockpit-context/db";
import { ADMIN_EMAILS, env, FORCE_SSO, SSO_ENABLED } from "@cockpit-context/env/server";
import {
  isEmailConfigured,
  queueEmail,
  renderResetPassword,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@cockpit-context/mailer";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import { adminPluginAccess } from "./admin-access.js";
import { announceIfUserBanned, announceUserSessionsRevoked } from "./ban.js";
import { bannedSessionGuard } from "./banned-session-guard.js";
import { revokeBootstrapToken } from "./bootstrap-token.js";
import { createResetLinkHooks } from "./invite-verification.js";
import { resolveMcpPlugins } from "./mcp-plugins.js";
import { revokeUserCredentials } from "./oauth-revocation.js";
import { createPasswordPepper } from "./password-pepper.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-policy.js";
import {
  hasAnyUser,
  invalidateSignupAvailabilityCache,
  isSignupOpen,
} from "./signup-availability.js";
import {
  markSignUpCreatedUser,
  neutralizeSignUpResponse,
  SIGN_UP_EMAIL_PATH,
  signupOpenForRequest,
  snapshotSignUpRequest,
} from "./signup-response.js";
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

// Which set-password links verify an address and who may spend them: only a
// link mailed to the address proves it (./invite-verification.ts).
const resetLinks = createResetLinkHooks({ emailConfigured });
// Better Auth runs after-hooks for APIError, but skips them for other thrown
// errors. Carry a failed post-sweep through that path so mailed-link verification
// still finishes before the original revocation error reaches the caller.
const resetRevocationFailures = new WeakMap<APIError, { error: unknown }>();

// Better-Auth emits "user input failed validation" cases (wrong password, unknown
// email, unverified email, etc.) at level=error. Those are normal end-user mistakes,
// not server faults — downgrade them to warn so production error dashboards stay
// signal-y. Anything we don't recognize keeps its original level.
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

type SendResetPassword = NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"];

const sendResetPassword: SendResetPassword = async ({ user, url, token }) => {
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
  // The link went to the mailbox: spending it verifies the address, and it
  // stays spendable once the account is active.
  await resetLinks.afterResetMailSent((await auth.$context).internalAdapter, {
    token,
    email: user.email,
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

export const passwordPepper = createPasswordPepper({
  secret: env.BETTER_AUTH_SECRET,
  previousSecret: env.BETTER_AUTH_SECRET_PREVIOUS,
});

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
    password: { hash: passwordPepper.hash, verify: passwordPepper.verify },
    enabled: !forceSso,
    requireEmailVerification: emailConfigured,
    // ./password-policy.ts: the same numbers the web's new-password forms
    // validate against and show under the field. The login form deliberately
    // does not, since an account created under an older policy must still be
    // able to authenticate.
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    revokeSessionsOnPasswordReset: true,
    ...(emailConfigured ? { sendResetPassword } : {}),
    onPasswordReset: async ({ user }) => {
      // Defense in depth after Better Auth commits the password and session deletion.
      announceUserSessionsRevoked(user.id);
      let revocationFailure: { error: unknown } | undefined;
      try {
        await revokeUserCredentials(user.id);
      } catch (err) {
        console.error(
          "SECURITY password-reset after-sweep failed",
          user.id,
          err instanceof Error ? err.name : typeof err,
        );
        revocationFailure = { error: err };
      }
      // Upstream cleanup is best-effort after the password is committed, even
      // when the post-sweep failed. Mailed-link verification runs in hooks.after.
      await resetLinks.afterPasswordReset((await auth.$context).adapter, user.id);
      if (revocationFailure) {
        const pending = new APIError("INTERNAL_SERVER_ERROR", {
          message: "Password-reset credential revocation failed",
        });
        resetRevocationFailures.set(pending, revocationFailure);
        throw pending;
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
    // requests; revocations/role changes propagate within 60s. That is also
    // the bound on a ban: every ban path deletes the user's sessions, but a
    // request carrying a cache cookie signed before the ban still resolves
    // the pre-ban user for up to `maxAge`. Closing it would need an
    // authoritative DB read per request or no cache (docs/access-matrix.md).
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
  hooks: {
    // Sign-up answers byte-identically for a free and a registered address,
    // so it is no account-existence oracle (./signup-response.ts).
    before: createAuthMiddleware(async (ctx) => {
      // Run before plugin hooks can resolve a signed cache copy. Anonymous
      // credential/token exchanges must still work with an old browser cookie.
      // Mixed endpoints (e.g. 2FA verification) are checked when they carry a
      // session token; without one, their anonymous challenge flow continues.
      const anonymous =
        ctx.path.startsWith("/sign-in/") ||
        ctx.path.startsWith("/sign-up/") ||
        ctx.path.startsWith("/callback/") ||
        ctx.path.startsWith("/oauth2/callback/") ||
        [
          "/sign-out",
          "/reset-password",
          "/request-password-reset",
          "/send-verification-email",
          "/oauth2/token",
          "/oauth2/register",
          "/oauth2/introspect",
          "/oauth2/revoke",
        ].includes(ctx.path);
      if (ctx.request && !["GET", "HEAD", "OPTIONS"].includes(ctx.method ?? "GET") && !anonymous) {
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (token) {
          // No secondaryStorage is configured: findSession reads the DB row.
          // A failed lookup throws before any write or cookie renewal.
          const live = await ctx.context.internalAdapter.findSession(token);
          if (!live || live.session.expiresAt <= new Date()) {
            ctx.context.session = null;
            deleteSessionCookie(ctx);
            // Before-hook errors bypass dispatch's normal header merge in 1.7.18.
            throw new APIError(
              "UNAUTHORIZED",
              { message: "Unauthorized", code: "UNAUTHORIZED" },
              ctx.responseHeaders,
            );
          }
          ctx.context.session = live;
        }
      }

      if (ctx.path === "/reset-password") {
        // Mirror 1.7.18's body/query token fallback and expiry comparison.
        const token = ctx.body?.token || ctx.query?.token;
        if (typeof token === "string" && token) {
          let userId: string | undefined;
          try {
            // Judge invite activation before the pre-sweep deletes live sessions:
            // a shown link must not become redeemable because we signed its owner out.
            await resetLinks.before(ctx);
            const verification = await ctx.context.internalAdapter.findVerificationValue(
              `reset-password:${token}`,
            );
            if (verification && !(verification.expiresAt < new Date())) {
              userId = verification.value;
              // Sessions and credentials are revoked under the same issuance lock.
              // If reset fails before committing, the user is signed out
              // everywhere with the password unchanged and reset link intact:
              // the safe direction.
              await revokeUserCredentials(userId, { revokeSessions: true });
            }
          } catch (error) {
            if (error instanceof APIError) throw error;
            console.error(
              "SECURITY password-reset preflight failed",
              userId ?? "unknown",
              error instanceof Error ? error.name : typeof error,
            );
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                "We couldn't finish securing your account. Nothing was changed — try the link again.",
            });
          }
        }
      }

      if (ctx.path === SIGN_UP_EMAIL_PATH) {
        await snapshotSignUpRequest(ctx, {
          emailVerificationRequired: emailConfigured,
          isSignupOpen,
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/change-password" &&
        ctx.body?.revokeOtherSessions === true &&
        !(ctx.context.returned instanceof APIError) &&
        ctx.context.session &&
        ctx.context.returned &&
        typeof ctx.context.returned === "object" &&
        "user" in ctx.context.returned
      ) {
        const userId = ctx.context.session.user.id;
        announceUserSessionsRevoked(userId);
        try {
          // Better Auth preserves the caller via a replacement session. Only
          // standing credentials are swept here; no session rows are deleted.
          await revokeUserCredentials(userId);
        } catch (error) {
          console.error(
            "SECURITY change-password after-sweep failed",
            userId,
            error instanceof Error ? error.name : typeof error,
          );
          throw error;
        }
      }

      if (ctx.path === SIGN_UP_EMAIL_PATH) {
        return neutralizeSignUpResponse(ctx, { emailVerificationRequired: emailConfigured });
      }
      const pending = ctx.context.returned;
      const revocationFailure =
        pending instanceof APIError ? resetRevocationFailures.get(pending) : undefined;
      // The callback ran only after the password committed. Even if its sweep
      // failed, finish upstream's per-token, mailbox-bound verification first.
      await resetLinks.after(
        revocationFailure
          ? { ...ctx, context: { ...ctx.context, returned: { status: true } } }
          : ctx,
      );
      if (revocationFailure) {
        throw revocationFailure.error;
      }
    }),
  },
  plugins: [
    // First, so a banned user's surviving session is refused on every
    // `/api/auth/*` route (sign-out excepted) before any other plugin's
    // before hook runs (./banned-session-guard.ts).
    bannedSessionGuard(),
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
      // claiming a code was sent. Since a failure here can never reach the
      // caller, the code is mailed after the response (queueEmail: bounded,
      // in memory, failures logged), so a slow relay never holds the request.
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
                queueEmail({ to: user.email, subject, html }, "two-factor code");
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
        after: async (user) => {
          invalidateSignupAvailabilityCache();
          // The admin plugin's `/admin/ban-user` and `/admin/update-user`
          // ban through here. Better-Auth runs this hook after the write
          // commits, so a listener that re-reads the user sees the ban.
          // Closes the user's open subscriptions (./ban.ts).
          // The adapter hands over null when the row vanished mid-update.
          if (user) announceIfUserBanned(user);
        },
      },
      create: {
        before: createUserCreateBeforeHook({
          emailConfigured,
          adminEmails: ADMIN_EMAILS,
          isSignupOpen: (ctx) => signupOpenForRequest(ctx, isSignupOpen),
          hasAnyUser: () => hasAnyUser({ fresh: true }),
        }),
        after: async (_user, ctx) => {
          // While sign-up is closed, the sign-up after-hook lets a 200 stand
          // only when this fired (./signup-response.ts).
          markSignUpCreatedUser(ctx);
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
