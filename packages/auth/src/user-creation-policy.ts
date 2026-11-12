import { AsyncLocalStorage } from "node:async_hooks";

export type UserCreationMode = "admin-bootstrap" | "admin-invite";

type UserCreationContext = {
  mode: UserCreationMode;
  /** The `admin-bootstrap` request's presented token, re-verified by the hook. */
  bootstrapToken?: string;
};

const userCreationModeStorage = new AsyncLocalStorage<UserCreationContext>();

// Single source of truth for the signup-disabled rejection message. The
// Better-Auth database hook throws it, the server signup gate returns it, and
// the admin-invite error translation in packages/api matches on it — keep the
// wording stable.
export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is currently disabled. Contact an admin if you need access.";

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
  opts: { bootstrapToken?: string } = {},
): T | Promise<T> {
  return userCreationModeStorage.run({ mode, bootstrapToken: opts.bootstrapToken }, fn);
}

export { cleanupBeforeUserDeletion, registerUserDeletionCleanup } from "./user-deletion-hooks.js";
