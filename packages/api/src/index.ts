import { isUserBanned } from "@cockpit-context/auth/ban";
import { isAdminRole } from "@cockpit-context/auth/roles";
import { ORPCError, os } from "@orpc/server";

import type { Context, CredentialKind } from "./context";
import { isTwoFactorPolicySatisfied } from "./lib/two-factor-policy";

export {
  invalidateForceTwoFactorSettingsCache,
  isForcedTwoFactorEnabledForRole,
  isTwoFactorPolicySatisfied,
} from "./lib/two-factor-policy";

const o = os.$context<Context>();

export const publicProcedure = o;

export type SessionAccessFailure = "unauthenticated" | "banned";

/**
 * The signed-in-user rule, defined once: a session with a user who is not
 * banned (`isUserBanned`). Every authenticated builder (`requireAuth`, so
 * `authenticatedProcedure`, `protectedProcedure` and `adminProcedure`),
 * `requireRequiredTwoFactor` and `checkAdminAuthority` start here, so a ban
 * ends access to every procedure, not only the admin ones.
 *
 * The check runs on every request because the admin plugin refuses a banned
 * user only when a session is CREATED: a session issued before the ban keeps
 * resolving through `getSession` until it is deleted or expires.
 * Every application ban path also deletes the user's sessions (`users.archive`,
 * account removal, the admin plugin's `/admin/ban-user` and `/admin/update-user`);
 * this closes the gap for a ban written straight to the database, which leaves
 * its sessions behind.
 *
 * Bound: the user is the one Better-Auth resolved for this request. On a
 * cookie-cache hit that is the signed copy from up to `cookieCache.maxAge`
 * (60 s, packages/auth/src/index.ts) ago, so a ban takes effect within that
 * window, exactly as a session deletion does. A long-lived subscription is
 * admitted here once, when it opens; the live-stream registry
 * (lib/live-streams.ts) re-reads the ban from the database at open and closes
 * it when the ban is announced.
 */
export function checkSessionAccess<S extends NonNullable<Context["session"]>>(
  session: S | null | undefined,
): { ok: true; session: S } | { ok: false; reason: SessionAccessFailure } {
  if (!session?.user) return { ok: false, reason: "unauthenticated" };
  if (isUserBanned(session.user)) return { ok: false, reason: "banned" };
  return { ok: true, session };
}

// A banned user is answered like a missing session: UNAUTHORIZED, no detail.
const requireAuth = o.middleware(async ({ context, next }) => {
  const access = checkSessionAccess(context.session);
  if (!access.ok) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: access.session,
    },
  });
});

export const authenticatedProcedure = publicProcedure.use(requireAuth);

const requireRequiredTwoFactor = o.middleware(async ({ context, next }) => {
  const access = checkSessionAccess(context.session);
  if (!access.ok) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (!(await isTwoFactorPolicySatisfied(access.session.user))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Two-factor authentication setup is required.",
    });
  }
  return next({
    context: {
      session: access.session,
    },
  });
});

export const protectedProcedure = authenticatedProcedure.use(requireRequiredTwoFactor);

export type AdminAuthorityFailure =
  | SessionAccessFailure
  | "api-key"
  | "unverified"
  | "not-admin"
  | "two-factor";

/**
 * The admin authority rule, defined once and checked in this order: a signed-in
 * user who is not banned (`checkSessionAccess`, the same rule every
 * authenticated procedure applies), not on an API key (a long-lived bearer credential that never went
 * through sign-in or 2FA; admin access needs a real session — cookie or a
 * device-flow token approved from a signed-in browser), with a verified email,
 * an admin role and the forced second factor. `requireAdmin`,
 * `requireAdminOr404` and the server's cookie-only `requireVerifiedAdminSession`
 * (apps/server/src/admin-session-gate.ts) all call this and only map the
 * failure to their own response. Do not re-derive the rule elsewhere.
 */
export async function checkAdminAuthority<S extends NonNullable<Context["session"]>>(
  session: S | null | undefined,
  credential?: CredentialKind,
): Promise<{ ok: true; session: S } | { ok: false; reason: AdminAuthorityFailure }> {
  const access = checkSessionAccess(session);
  if (!access.ok) return access;
  if (credential === "api-key") return { ok: false, reason: "api-key" };
  const { user } = access.session;
  if (!user.emailVerified) return { ok: false, reason: "unverified" };
  if (!isAdminRole(user.role)) return { ok: false, reason: "not-admin" };
  if (!(await isTwoFactorPolicySatisfied(user))) return { ok: false, reason: "two-factor" };
  return access;
}

const ADMIN_FORBIDDEN_MESSAGES: Record<
  Exclude<AdminAuthorityFailure, "unauthenticated" | "banned">,
  string
> = {
  "api-key": "API keys cannot be used for admin access.",
  unverified: "Email verification required for admin access.",
  "not-admin": "Admin access required.",
  "two-factor": "Two-factor authentication setup is required.",
};

const requireAdmin = o.middleware(async ({ context, next }) => {
  // `requireAuth` is always chained before this middleware; the rule repeats
  // the session check anyway, which also narrows the type. A banned user is
  // answered like a missing session.
  const authority = await checkAdminAuthority(context.session, context.credential);
  if (!authority.ok) {
    if (authority.reason === "unauthenticated" || authority.reason === "banned") {
      throw new ORPCError("UNAUTHORIZED");
    }
    throw new ORPCError("FORBIDDEN", { message: ADMIN_FORBIDDEN_MESSAGES[authority.reason] });
  }
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminProcedure = publicProcedure.use(requireAuth).use(requireAdmin);

// `adminOr404Procedure` applies the same rule as `requireAdmin`
// (checkAdminAuthority) but throws NOT_FOUND for every failure mode (missing
// session, ban, API key, unverified email, non-admin role, missing 2FA). Mount it on
// procedures that back a 404-hidden surface (e.g. the /admin route group) so
// existence of the endpoint is not leaked to non-admins.
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const authority = await checkAdminAuthority(context.session, context.credential);
  if (!authority.ok) throw new ORPCError("NOT_FOUND", { message: "Not found" });
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminOr404Procedure = publicProcedure.use(requireAdminOr404);

// -- authorization registry --------------------------------------------------
//
// `pnpm policy:access-matrix` reads these two objects statically (it parses
// this file; it never imports it) and FAILS on any router procedure whose
// chain starts at a builder, or passes `.use()` a middleware, that is not
// listed here. That is deliberate: an authorization check that exists only
// inline in one router is invisible to the gate and to the next agent, and
// two hand-written copies of the same check drift. So the rule for auth is
// "register at two, not extract at three" — the second router that needs a
// role check gets an entry here (and a builder above), not a local helper.
// See docs/development.md § Change workflow.
//
// The level is the *minimum* a caller must hold to get past the gate. The
// access matrix in docs/access-matrix.md is checked against it.

export type ProcedureAccessLevel = "public" | "authenticated" | "admin";

/** Builders a router procedure chain may start from. Keep in sync with the exports above. */
export const procedureAccessLevels = {
  publicProcedure: "public",
  authenticatedProcedure: "authenticated",
  protectedProcedure: "authenticated",
  adminProcedure: "admin",
  adminOr404Procedure: "admin",
} as const satisfies Record<string, ProcedureAccessLevel>;

/** Middleware a router procedure may pass to `.use()`. Custom role helpers register here. */
export const middlewareAccessLevels = {
  requireAuth: "authenticated",
  requireRequiredTwoFactor: "authenticated",
  requireAdmin: "admin",
  requireAdminOr404: "admin",
} as const satisfies Record<string, ProcedureAccessLevel>;
