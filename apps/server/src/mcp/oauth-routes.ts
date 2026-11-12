import type { Session } from "@cockpit-context/auth";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { resolveClientIp } from "../client-ip.js";
import {
  createRateLimiterMiddleware,
  mcpConsentLimiter,
  mcpOauthLimiter,
  mcpRegistrationLimiter,
} from "../rate-limit.js";

/**
 * The MCP OAuth routes' limits and body caps (ported from ws-model-proxy's
 * `mcp-oauth-route-match.ts` + `mcp-oauth-rate-limit.ts`).
 *
 * Every decision uses the RAW method and RAW (still percent-encoded)
 * pathname: better-call, the router inside Better-Auth, routes on the raw
 * pathname, while Hono's `c.req.path` decodes it — so `/api/%61uth/oauth2/
 * token` matches Hono's `/api/auth/*` but is not the token route downstream.
 * Near-misses keep the general auth limiter.
 */

const MCP_OAUTH_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
export const MCP_OAUTH_TOKEN_PATH = "/api/auth/oauth2/token";
export const MCP_OAUTH_CONSENT_PATH = "/api/auth/oauth2/consent";
export const MCP_OAUTH_CONTINUE_PATH = "/api/auth/oauth2/continue";
export const MCP_OAUTH_REGISTER_PATH = "/api/auth/oauth2/register";
const MCP_OAUTH_REVOKE_PATH = "/api/auth/oauth2/revoke";

/** Exact method+path pairs handled by the MCP OAuth limiters instead of `authLimiter`. */
const MCP_OAUTH_RATE_LIMITED_ROUTES = [
  ["GET", MCP_OAUTH_AUTHORIZE_PATH],
  ["POST", MCP_OAUTH_AUTHORIZE_PATH],
  ["POST", MCP_OAUTH_CONSENT_PATH],
  ["POST", MCP_OAUTH_CONTINUE_PATH],
  ["POST", MCP_OAUTH_TOKEN_PATH],
  ["POST", MCP_OAUTH_REVOKE_PATH],
  ["POST", MCP_OAUTH_REGISTER_PATH],
  ["GET", "/api/auth/oauth2/public-client"],
  ["POST", "/api/auth/oauth2/public-client-prelogin"],
  ["GET", "/api/auth/jwks"],
] as const;

/**
 * Where an OAuth client may authenticate with `Authorization: Basic`
 * (`client_secret_basic`). Every other `/api/auth/*` request has its
 * Authorization header stripped (apps/server/src/index.ts).
 */
export const MCP_OAUTH_CLIENT_AUTH_PATHS: ReadonlySet<string> = new Set([
  MCP_OAUTH_TOKEN_PATH,
  MCP_OAUTH_REVOKE_PATH,
  "/api/auth/oauth2/introspect",
]);

const RATE_LIMITED_KEYS = new Set<string>(
  MCP_OAUTH_RATE_LIMITED_ROUTES.map(([method, path]) => `${method} ${path}`),
);

/** The raw, still-encoded pathname. */
function rawPathname(c: Context): string {
  return new URL(c.req.raw.url).pathname;
}

function isMcpOauthRoute(c: Context, method: string, path: string): boolean {
  return c.req.raw.method.toUpperCase() === method && rawPathname(c) === path;
}

export function isMcpOauthRateLimitedRequest(c: Context): boolean {
  return RATE_LIMITED_KEYS.has(`${c.req.raw.method.toUpperCase()} ${rawPathname(c)}`);
}

/** Narrow a middleware to one exact raw method+path. */
export function onMcpOauthRoute(
  method: string,
  path: string,
  handler: MiddlewareHandler,
): MiddlewareHandler {
  return (c, next) => (isMcpOauthRoute(c, method, path) ? handler(c, next) : next());
}

function consentKey(c: Context): string {
  const session = c.get("session") as Session | null | undefined;
  return session?.user?.id ? `uid:${session.user.id}` : `ip:${resolveClientIp(c)}`;
}

const consentLimit = createRateLimiterMiddleware(mcpConsentLimiter, {
  failClosed: true,
  resolveKey: consentKey,
});
/** Whole-service registration bucket; mounted on exactly POST /oauth2/register. */
export const mcpRegistrationLimit = createRateLimiterMiddleware(mcpRegistrationLimiter, {
  failClosed: true,
  resolveKey: () => "global",
});
const protocolLimit = createRateLimiterMiddleware(mcpOauthLimiter, {
  failClosed: true,
  resolveKey: (c) => resolveClientIp(c),
});

/** Selects the MCP OAuth bucket for an allowlisted route; anything else passes through. */
export const mcpOauthRateLimits: MiddlewareHandler = async (c, next) => {
  if (!isMcpOauthRateLimitedRequest(c)) return next();
  if (
    isMcpOauthRoute(c, "POST", MCP_OAUTH_CONSENT_PATH) ||
    isMcpOauthRoute(c, "POST", MCP_OAUTH_CONTINUE_PATH)
  ) {
    return consentLimit(c, next);
  }
  return protocolLimit(c, next);
};

/**
 * OAuth protocol bodies are tiny: authorize/token forms are ~1-2 KB, the
 * consent JSON carries the signed `oauth_query` (a few KB), a registration a
 * client metadata document. An order of magnitude of headroom each.
 */
export const MCP_OAUTH_FORM_MAX_BODY_BYTES = 16 * 1024;
export const MCP_OAUTH_CONSENT_MAX_BODY_BYTES = 32 * 1024;

export function mcpOauthBodyCap(maxBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: "Request is too large. Try sending less data." }, 413),
  });
}
