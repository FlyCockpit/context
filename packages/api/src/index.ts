import { isAdminRole } from "@cockpit-context/auth/roles";
import { ORPCError, os } from "@orpc/server";

import type { Context } from "./context";
import { isTwoFactorPolicySatisfied } from "./lib/two-factor-policy";

export {
  invalidateForceTwoFactorSettingsCache,
  isForcedTwoFactorEnabledForRole,
  isTwoFactorPolicySatisfied,
} from "./lib/two-factor-policy";

const o = os.$context<Context>();

export const publicProcedure = o;

const requireAuth = o.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const authenticatedProcedure = publicProcedure.use(requireAuth);

const requireRequiredTwoFactor = o.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Two-factor authentication setup is required.",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const protectedProcedure = authenticatedProcedure.use(requireRequiredTwoFactor);

const requireAdmin = o.middleware(async ({ context, next }) => {
  // `requireAuth` is always chained before this middleware, so session is
  // non-null at runtime — but the middleware-chain types don't carry that
  // narrowing through, so repeat the guard for the type checker.
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  // An API key is a long-lived bearer credential that never went through
  // sign-in or 2FA; admin procedures need a real session (cookie or a
  // device-flow token approved from a signed-in browser).
  if (context.credential === "api-key") {
    throw new ORPCError("FORBIDDEN", {
      message: "API keys cannot be used for admin access.",
    });
  }
  if (!context.session.user.emailVerified) {
    throw new ORPCError("FORBIDDEN", {
      message: "Email verification required for admin access.",
    });
  }
  if (!isAdminRole(context.session.user.role)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Admin access required.",
    });
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Two-factor authentication setup is required.",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const adminProcedure = publicProcedure.use(requireAuth).use(requireAdmin);

// `adminOr404Procedure` mirrors the role check in `requireAdmin` but throws
// NOT_FOUND for every failure mode (missing session, unverified email,
// non-admin role). Mount it on procedures that back a 404-hidden surface
// (e.g. the /admin route group) so existence of the endpoint is not leaked
// to non-admins.
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const notFound = () => new ORPCError("NOT_FOUND", { message: "Not found" });
  if (!context.session?.user) {
    throw notFound();
  }
  if (context.credential === "api-key") {
    throw notFound();
  }
  if (!context.session.user.emailVerified) {
    throw notFound();
  }
  if (!isAdminRole(context.session.user.role)) {
    throw notFound();
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw notFound();
  }
  return next({
    context: {
      session: context.session,
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
