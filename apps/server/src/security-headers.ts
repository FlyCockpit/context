import type { Env, Hono } from "hono";
import { NONCE, secureHeaders } from "hono/secure-headers";

type SecurityHeadersOptions = {
  // connect-src list for the app CSP (self + optional CORS origin).
  cspConnectSrc: string[];
  // sha256 hash authorizing the inlined anti-FOUC theme bootstrap script.
  themeInitCspHash: string;
};

/**
 * Registers the global security headers.
 *
 * A route that needs a different CSP (for example a `sandbox` policy on raw
 * user bytes) must register its override BEFORE this middleware:
 * `secureHeaders` writes the policy *after* `await next()`, and in Hono's onion
 * model the OUTER middleware's post-`next()` code runs last, so an override
 * registered after it is clobbered back to the app policy.
 */
export function mountSecurityHeaders<E extends Env>(
  app: Hono<E>,
  { cspConnectSrc, themeInitCspHash }: SecurityHeadersOptions,
): void {
  // Secure-headers — sets a battery of security headers (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, etc.) on every response.
  app.use(
    "/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // NONCE generates a fresh per-request nonce, exposed as
        // c.get("secureHeadersNonce"). The SSR handler forwards it to TanStack
        // Start so its inline hydration scripts carry a matching nonce.
        // Never add 'unsafe-eval'.
        scriptSrc: [NONCE, "'self'", themeInitCspHash],
        // Intentional template tradeoff: Tailwind/shadcn-driven app UI and AI
        // generated small-business customizations often rely on inline styles.
        // Keep script-src strict; remove this only after auditing app-specific UI.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        // Same-origin workers only (the PWA service worker). Never add blob:
        // to script-src.
        workerSrc: ["'self'"],
        connectSrc: cspConnectSrc,
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Injected markup cannot POST credentials to an attacker origin. Safe
        // with genericOAuth: the SSO handshake is redirect-based, not a form
        // POST. A SAML IdP using HTTP-POST binding would need its origin added.
        formAction: ["'self'"],
      },
    }),
  );
}
