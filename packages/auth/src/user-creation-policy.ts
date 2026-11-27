import { AsyncLocalStorage } from "node:async_hooks";
import type { Locale } from "@cockpit-context/config/locales";
import { APIError } from "better-auth/api";

export type UserCreationMode = "admin-bootstrap" | "admin-invite";

type UserCreationContext = {
  mode: UserCreationMode;
  /** The `admin-bootstrap` request's presented token, re-verified by the hook. */
  bootstrapToken?: string;
  /**
   * The language the server chose for the new account (an admin invite picks
   * the invitee's). The user-create hook seeds `User.locale` from it instead
   * of the request header, which a server-side `auth.api.createUser` lacks.
   */
  locale?: Locale;
};

const userCreationModeStorage = new AsyncLocalStorage<UserCreationContext>();

// Single source of truth for the signup-disabled rejection message. The
// Better-Auth database hook throws it, the server signup gate returns it, and
// the admin-invite error translation in packages/api matches on it — keep the
// wording stable.
export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is currently disabled. Contact an admin if you need access.";

// Why any creation is refused while no account exists and the request is not
// a valid first-admin bootstrap. One message for every address, listed or
// not, so it reveals nothing about ADMIN_EMAILS.
export const FIRST_ACCOUNT_REQUIRES_BOOTSTRAP_MESSAGE =
  "This server has no account yet. The first account must be the administrator: use an ADMIN_EMAILS address and the bootstrap token from the latest server start.";

export type UserCreationDecisionInput = {
  /** Effective open signup: SIGNUP_ENABLED AND the `signupOpen` AppSetting. */
  signupOpen: boolean;
  /** The AsyncLocalStorage mode the caller ran the creation under, if any. */
  creationMode: UserCreationMode | undefined;
  /** The new row's (lowercased) email is on the ADMIN_EMAILS allowlist. */
  isAdminEmail: boolean;
  /** SMTP is configured (`isEmailConfigured()`). */
  emailConfigured: boolean;
  /** Any account already exists (fresh read). The bootstrap closes for good then. */
  usersExist: boolean;
  /** The request presented the active one-time bootstrap token (./bootstrap-token.ts). */
  bootstrapTokenValid: boolean;
};

export type UserCreationDecision =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      /** Set only for the ADMIN_EMAILS bootstrap; otherwise the row keeps its role. */
      role?: "admin";
      /**
       * Without SMTP there is no way to verify an address, so the row is created
       * verified — otherwise `emailVerified`-gated surfaces (admin access) could
       * never be reached. With SMTP the email verification flow applies.
       */
      forceEmailVerified: boolean;
    };

/**
 * Pure user-creation decision for the Better-Auth `user.create.before` hook.
 * Takes every input as a parameter (no env, no database) so the whole gate
 * matrix is unit-testable.
 *
 * - While no account exists, the ONLY admitted creation is the first-admin
 *   bootstrap. Open signup, SSO/JIT and a listed address with a wrong or
 *   missing token are all refused, so a typo can never create a plain first
 *   account that closes the bootstrap for good and leaves the server without
 *   an administrator.
 * - Open signup (env AND setting) admits everyone with the default role.
 * - An admin invite (`users.invite`, mode `admin-invite`) is admitted even
 *   with signup closed.
 * - The ADMIN_EMAILS bootstrap (mode `admin-bootstrap`, set by the server
 *   marker only for listed addresses carrying the bootstrap token, and
 *   re-checked here) is admitted even with signup closed and becomes admin —
 *   but only while no account exists at all, with or without SMTP (see
 *   `resolveAdminBootstrapOpen`).
 */
export function decideUserCreation(input: UserCreationDecisionInput): UserCreationDecision {
  const mayBootstrapAdmin =
    input.creationMode === "admin-bootstrap" &&
    input.isAdminEmail &&
    input.bootstrapTokenValid &&
    !input.usersExist;
  const isAdminInvite = input.creationMode === "admin-invite";

  if (!input.usersExist && !mayBootstrapAdmin) {
    return { allowed: false, reason: FIRST_ACCOUNT_REQUIRES_BOOTSTRAP_MESSAGE };
  }

  if (!input.signupOpen && !mayBootstrapAdmin && !isAdminInvite) {
    return { allowed: false, reason: SIGNUP_DISABLED_MESSAGE };
  }

  return {
    allowed: true,
    ...(mayBootstrapAdmin ? { role: "admin" as const } : {}),
    forceEmailVerified: !input.emailConfigured,
  };
}

export function getAllowedUserCreationMode(): UserCreationMode | undefined {
  return userCreationModeStorage.getStore()?.mode;
}

/** The bootstrap token the current `admin-bootstrap` creation presented, if any. */
export function getBootstrapTokenCandidate(): string | undefined {
  return userCreationModeStorage.getStore()?.bootstrapToken;
}

// One process owns signup. The signup middleware serializes EVERY email signup
// (whether or not the address is on ADMIN_EMAILS) through this queue, so the
// first-admin check and the user insert cannot interleave between two requests,
// and queueing never depends on secret allowlist membership (no timing oracle).
let signupTail: Promise<void> = Promise.resolve();

export function serializeSignup<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = signupTail;
  let release: () => void = () => {};
  signupTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

export function runWithAllowedUserCreation<T>(
  mode: UserCreationMode,
  fn: () => T | Promise<T>,
  opts: { bootstrapToken?: string; locale?: Locale } = {},
): T | Promise<T> {
  return userCreationModeStorage.run(
    { mode, bootstrapToken: opts.bootstrapToken, locale: opts.locale },
    fn,
  );
}

/**
 * The locale the current grant chose for the account being created, if any.
 * Server-chosen (the invite form's language field, validated by the API), so
 * it beats the client's locale header.
 */
export function getGrantedUserLocale(): Locale | undefined {
  return userCreationModeStorage.getStore()?.locale;
}

/** Better-Auth's admin route that creates a user (`auth.api.createUser`). */
export const ADMIN_CREATE_USER_PATH = "/admin/create-user";

/**
 * Better-Auth routes where an IdP signs the user in: the OAuth/OIDC callback
 * (`/callback/<providerId>`, which the genericOAuth SSO provider uses) and an
 * ID-token sign-in (`/sign-in/social`). Their `emailVerified` is the IdP's
 * `email_verified` claim, which Cockpit Context trusts (docs/access-matrix.md).
 */
function isIdpSignInPath(path: string | undefined): boolean {
  return path === "/sign-in/social" || (path?.startsWith("/callback/") ?? false);
}

/**
 * Two rules for every user row Better-Auth creates, checked first in the
 * `user.create.before` hook (./user-create-hook.ts):
 *
 * - `/admin/create-user` runs only under the `admin-invite` grant, that is only
 *   from `users.invite` on the server, which never lets anyone choose the
 *   password or the verification state. An admin session can reach Better-Auth's
 *   own route over HTTP (`/api/auth/admin/*`); that call is refused, open signup
 *   or not. Otherwise an admin could create an account with a password they
 *   chose and `data: { emailVerified: true }`.
 * - A new row may arrive verified only from an IdP sign-in. Everywhere else
 *   (sign-up forces `false` itself) the address is unproved until a link mailed
 *   to it is used. The hook itself still creates every row verified when SMTP
 *   is off (`forceEmailVerified`), where no address can be proved at all.
 */
export function refuseUnprovedUserCreation(
  user: { emailVerified?: unknown },
  context: { path?: string } | null | undefined,
): void {
  const path = context?.path;
  if (path === ADMIN_CREATE_USER_PATH && getAllowedUserCreationMode() !== "admin-invite") {
    throw new APIError("FORBIDDEN", {
      message: "Invite users from the admin dashboard.",
      code: "ADMIN_CREATE_USER_UNSUPPORTED",
    });
  }
  if (user.emailVerified === true && !isIdpSignInPath(path)) {
    throw new APIError("BAD_REQUEST", {
      message: "An email address is verified only through the link mailed to it.",
      code: "EMAIL_VERIFICATION_BY_MAIL_ONLY",
    });
  }
}

export { cleanupBeforeUserDeletion, registerUserDeletionCleanup } from "./user-deletion-hooks.js";
