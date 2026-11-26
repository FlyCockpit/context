import { signupMode } from "@/lib/signup-mode";

/**
 * What the public landing offers next to "Sign in", from the public
 * `appConfig` (`signupMode`, docs/ui.md § Sign-up modes):
 * - `setup`: no account exists yet and the first-admin bootstrap is open, so
 *   the operator's next step is "Set up this server" (/signup with the token).
 * - `signup`: open sign-up is on (only ever once the administrator exists).
 * - `invite-only`: sign-up is closed; Sign in plus the invite-only line, so a
 *   visitor without an account is not left guessing.
 * - `null`: sign-in only (SSO-only, or still loading).
 */
export type LandingEntry = "setup" | "signup" | "invite-only" | null;

export function landingEntry(
  config:
    | { forceSso: boolean; signupOpen: boolean; adminBootstrapSignupEnabled: boolean }
    | undefined,
): LandingEntry {
  if (!config) return null;
  switch (signupMode(config)) {
    case "bootstrap":
      return "setup";
    case "open":
      return "signup";
    case "closed":
      return "invite-only";
    default:
      // SSO-only servers have no password sign-up: /signup deflects to /login.
      return null;
  }
}
