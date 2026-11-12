import { verifyBootstrapToken } from "./bootstrap-token.js";
import { resolveSignupLocale } from "./signup-locale.js";
import {
  decideUserCreation,
  getAllowedUserCreationMode,
  getBootstrapTokenCandidate,
} from "./user-creation-policy.js";

export type UserCreateHookDeps = {
  emailConfigured: boolean;
  adminEmails: ReadonlySet<string>;
  /** Effective open signup (cached read is fine: `settings.update` invalidates it). */
  isSignupOpen: () => Promise<boolean>;
  /** MUST be a fresh read: this hook is the authorization boundary for the bootstrap. */
  hasAnyUser: () => Promise<boolean>;
  /** Constant-time check against the active one-time bootstrap token. */
  verifyBootstrapToken?: (candidate: unknown) => boolean;
};

/**
 * Builds the Better-Auth `databaseHooks.user.create.before` hook. Every user
 * row — email/password signup, admin invite (`auth.api.createUser`) and
 * SSO/JIT — passes through here, so this is the single enforcement point for
 * the signup policy (see `decideUserCreation`).
 *
 * A factory with injected reads so the real Better-Auth sign-up flow can be
 * exercised in tests against an in-memory adapter.
 */
export function createUserCreateBeforeHook(deps: UserCreateHookDeps) {
  return async <U extends { email?: string | null }>(
    user: U,
    context: { headers?: Headers | null } | null | undefined,
  ) => {
    const email = user.email?.toLowerCase();
    // The account-existence read runs for EVERY creation (not only for
    // allowlisted addresses), so its latency cannot tell a listed address from
    // an unlisted one.
    const [signupOpen, usersExist] = await Promise.all([deps.isSignupOpen(), deps.hasAnyUser()]);
    const creationMode = getAllowedUserCreationMode();
    // Re-verified here (the server marker checked it too): the token must still
    // be the active one. Signups are serialized and the token is revoked once
    // any account exists, so it can admit at most one admin.
    const bootstrapTokenValid =
      creationMode === "admin-bootstrap" &&
      (deps.verifyBootstrapToken ?? verifyBootstrapToken)(getBootstrapTokenCandidate());
    // ADMIN_EMAILS promotion is only for the explicit email/password bootstrap
    // path wrapped by the server signup marker. Never infer it from SSO/JIT
    // user creation or from emailVerified claims.
    const decision = decideUserCreation({
      signupOpen,
      creationMode,
      isAdminEmail: !!email && deps.adminEmails.has(email),
      emailConfigured: deps.emailConfigured,
      usersExist,
      bootstrapTokenValid,
    });
    if (!decision.allowed) {
      throw new Error(decision.reason);
    }
    const locale = resolveSignupLocale(context?.headers);
    return {
      data: {
        ...user,
        locale,
        ...(decision.role ? { role: decision.role } : {}),
        ...(decision.forceEmailVerified ? { emailVerified: true } : {}),
      },
    };
  };
}
