import { BOOTSTRAP_TOKEN_HEADER } from "@cockpit-context/auth/signup-policy";
import { APP_LOCALE_HEADER } from "@cockpit-context/config/locales";

/**
 * Request headers the browser is allowed to send cross-origin.
 *
 * Every header the client sets on a cross-origin request must appear here. A
 * custom header that isn't listed makes the browser's preflight fail, and the
 * real request is never sent — so the failure surfaces as "sign-in silently
 * does nothing", not as a readable error.
 *
 * This is easy to get wrong because the CORS middleware only mounts when
 * `CORS_ORIGIN` is set, and local development proxies the API same-origin
 * through Vite. An omission here therefore passes every local check and breaks
 * authentication on the first split-origin production deploy.
 *
 * Current entries and who sends them:
 *   - `Content-Type` / `Authorization` — standard.
 *   - `x-csrf-token` — Better-Auth's SimpleCsrfProtectionLinkPlugin, every request.
 *   - APP_LOCALE_HEADER — the auth client (apps/web/src/lib/auth-client.ts),
 *     every auth request.
 *   - BOOTSTRAP_TOKEN_HEADER — the first-admin signup form (one request).
 *
 * **Adding a client-set header means adding it here.** cors-headers.test.ts
 * asserts the preflight actually echoes each one.
 */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "x-csrf-token",
  APP_LOCALE_HEADER,
  BOOTSTRAP_TOKEN_HEADER,
] as const;
