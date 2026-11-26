/**
 * The extra entry point the public landing offers next to "Sign in", from the
 * public `appConfig`:
 * - `setup`: no account exists yet and the first-admin bootstrap is open, so
 *   the operator's next step is "Set up this server" (/signup with the token).
 * - `signup`: open sign-up is on (only ever once the administrator exists).
 * - `null`: sign-in only (closed sign-up, SSO-only, or still loading).
 */
export type LandingEntry = "setup" | "signup" | null;

export function landingEntry(
  config:
    | { forceSso: boolean; signupOpen: boolean; adminBootstrapSignupEnabled: boolean }
    | undefined,
): LandingEntry {
  // SSO-only servers have no password sign-up: /signup deflects to /login.
  if (!config || config.forceSso) return null;
  if (config.adminBootstrapSignupEnabled) return "setup";
  return config.signupOpen ? "signup" : null;
}
