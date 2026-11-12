/**
 * The shared, dependency-free core of the signup policy.
 *
 * Imported by the server-side reader (`./signup-availability.ts`, which adds
 * the AppSetting read and its cache) and by the browser (the admin settings
 * page), so both resolve the stored toggle with the same rule.
 *
 * Effective signup = `SIGNUP_ENABLED` (env, the ceiling, default `false`)
 * AND the `signupOpen` AppSetting (the admin's runtime toggle). An absent row
 * means "open as far as the env allows", so `SIGNUP_ENABLED=true` keeps its
 * default meaning until an admin closes signup. Any stored value other than
 * the literal `"true"` reads as closed (fail closed on a corrupt row).
 */
export const SIGNUP_OPEN_SETTING_KEY = "signupOpen";

/** Request header carrying the one-time first-admin bootstrap token (./bootstrap-token.ts). */
export const BOOTSTRAP_TOKEN_HEADER = "x-cockpit-bootstrap-token";

export function resolveSignupOpen(
  envSignupEnabled: boolean,
  storedValue: string | null | undefined,
): boolean {
  if (!envSignupEnabled) return false;
  if (storedValue === undefined || storedValue === null) return true;
  return storedValue === "true";
}

/**
 * Whether the ADMIN_EMAILS first-admin bootstrap is open: an allowlist exists,
 * NO account exists yet (the ws-model-proxy rule — it closes for good as soon
 * as any user exists, with or without SMTP), and this process holds an
 * unconsumed one-time bootstrap token (printed to the boot log; a restart
 * issues one). Independent of open signup: the first listed address to
 * present the token becomes admin either way.
 */
export function resolveAdminBootstrapOpen(opts: {
  adminEmailCount: number;
  usersExist: boolean;
  tokenActive: boolean;
}): boolean {
  return opts.adminEmailCount > 0 && !opts.usersExist && opts.tokenActive;
}

/**
 * What a signed-out visitor is told while no administrator exists (null once
 * one does). Revealing "no admin yet" is acceptable: such a server is not
 * usable by anyone until the operator finishes setup.
 * - `bootstrap`: the first-admin signup with the boot-log token is open.
 * - `configure`: set ADMIN_EMAILS and restart (no allowlist, or no token in
 *   this process — a restart issues one while no account exists).
 * - `locked`: accounts exist but none is an admin; the bootstrap is closed.
 */
export type AdminSetupState = "bootstrap" | "configure" | "locked" | null;

export function resolveAdminSetupState(opts: {
  adminExists: boolean;
  adminBootstrapOpen: boolean;
  usersExist: boolean;
}): AdminSetupState {
  if (opts.adminExists) return null;
  if (opts.adminBootstrapOpen) return "bootstrap";
  return opts.usersExist ? "locked" : "configure";
}
