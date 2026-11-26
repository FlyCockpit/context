/**
 * How a visitor gets an account on this server, read from the public
 * `appConfig` (packages/api/src/routers/index.ts). The landing page, sign-in
 * and `/signup` all branch on this one value so they always tell the same
 * story. docs/ui.md § Sign-up modes.
 *
 * - `open`: anyone can create an account (`SIGNUP_ENABLED` and the admin's
 *   runtime toggle; only ever once an account exists).
 * - `bootstrap`: no account exists yet, and an `ADMIN_EMAILS` address with the
 *   boot-log token may create the first (administrator) account. Unlike the
 *   template's static flag, this one turns off once the first account exists.
 * - `closed`: invite-only; an administrator creates accounts.
 * - `sso`: `FORCE_SSO`; the identity provider is the only way in, and the SSO
 *   sign-in page keeps its own copy.
 */
export type SignupMode = "open" | "bootstrap" | "closed" | "sso";

type SignupConfig = {
  forceSso?: boolean;
  signupOpen?: boolean;
  adminBootstrapSignupEnabled?: boolean;
};

export function signupMode(config: SignupConfig): SignupMode {
  if (config.forceSso === true) return "sso";
  if (config.adminBootstrapSignupEnabled === true) return "bootstrap";
  if (config.signupOpen === true) return "open";
  return "closed";
}
