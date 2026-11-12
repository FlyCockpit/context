import { DEFAULT_LOCALE, type Locale } from "@cockpit-context/config/locales";

/**
 * Pure MCP OAuth configuration (docs/mcp.md), ported from
 * ws-model-proxy's `mcp-config.ts` without its READ/FULL levels: Cockpit Context has one
 * capability level, plus the per-connection `allowPropose` / `autoApprove`
 * flags recorded on `McpGrant`.
 *
 * Everything is derived from `BETTER_AUTH_URL` and named constants, never
 * new env vars: one canonical MCP resource (`<origin>/mcp`), the issuer
 * (`<origin>/api/auth`), and fixed token lifetimes. The derivations take
 * explicit inputs so tests can compute them for any origin.
 */

/** Resource-bound MCP access JWT lifetime: 10 minutes. */
export const MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;

/** Rolling refresh-token inactivity lifetime: 72 hours. */
export const MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS = 72 * 60 * 60;

/** Cached refresh-response retry window: 30 seconds. */
export const MCP_REFRESH_RETRY_WINDOW_SECONDS = 30;

/** Client ID Metadata Documents, pinned to the MCP 2026-07-28 profile. */
export const MCP_METADATA_PROFILE = "mcp-2026-07-28";

/**
 * The one resource scope: "use Cockpit Context's MCP tools as me". Cockpit Context has a single
 * capability level; what a connection may additionally do (propose packages,
 * auto-approve) is a per-grant flag the person sets on the consent page,
 * never a scope a client can ask for.
 */
export const MCP_RESOURCE_SCOPE = "mcp";

/** Every scope this server can mint. */
export const MCP_SCOPES = [MCP_RESOURCE_SCOPE, "offline_access"] as const;

/** The resource scopes: `scopes_supported` in the protected-resource metadata and the challenge. */
export const MCP_RESOURCE_SCOPES = [MCP_RESOURCE_SCOPE] as const;

/** Registration ceiling: the scopes a dynamically registered client gets. */
export const MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES = [
  MCP_RESOURCE_SCOPE,
  "offline_access",
] as const;

/** OAuth issuer / authorization-server base: `<origin>/api/auth`. */
export function canonicalMcpIssuer(baseUrl: string): string {
  return new URL("/api/auth", baseUrl).toString();
}

/** RFC 8707 resource identifier for this MCP server: `<origin>/mcp`. */
export function canonicalMcpResource(baseUrl: string): string {
  return new URL("/mcp", baseUrl).toString();
}

/** Locale-prefixed MCP login route (`/$lang/mcp-login`). */
export function mcpLoginPagePath(locale: Locale = DEFAULT_LOCALE): string {
  return `/${locale}/mcp-login`;
}

/** Locale-prefixed MCP consent route (`/$lang/mcp-consent`). */
export function mcpConsentPagePath(locale: Locale = DEFAULT_LOCALE): string {
  return `/${locale}/mcp-consent`;
}

/**
 * Split/deduplicate an OAuth `scope` claim (space-separated string or list).
 * Splits on the ASCII space only and never trims tokens into validity: a
 * string with leading/trailing whitespace grants nothing.
 */
export function parseMcpScopes(scope: string | readonly string[] | null | undefined): string[] {
  if (typeof scope === "string") {
    if (scope !== scope.trim()) return [];
    return [...new Set(scope.split(" ").filter((entry) => entry.length > 0))];
  }
  return [...new Set(scope ?? [])];
}

/** Whether a presented scope set carries the MCP resource scope. */
export function mcpScopesAllow(scope: string | readonly string[] | null | undefined): boolean {
  return parseMcpScopes(scope).includes(MCP_RESOURCE_SCOPE);
}
