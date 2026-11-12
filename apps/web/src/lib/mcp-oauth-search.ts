/**
 * Pure helpers for the MCP login and consent pages (ported from
 * ws-model-proxy's `lib/mcp-oauth-search.ts`).
 *
 * The signed OAuth transaction lives in the page URL as query parameters
 * (`client_id`, `scope`, `redirect_uri`, …, plus `sig` and the `ba_param`
 * list of signed names). Better-Auth's `oauthProviderClient()` reads the raw
 * `window.location.search` and forwards exactly the signed parameters as
 * `oauth_query` on every non-GET auth request; the pages never rebuild,
 * re-sign or append OAuth state. These helpers only read what is in the URL.
 *
 * Navigation between the two pages must use the RAW query: TanStack Router
 * re-serializes search, which collapses the repeated `ba_param` keys and
 * breaks the signature. Always build hrefs from `window.location.search`.
 */

export interface McpOAuthSearchInfo {
  clientId: string | null;
  /** Whether the URL carries the `sig` signature and the signed-name list. */
  usable: boolean;
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

export function parseMcpOAuthSearch(rawSearch: string): McpOAuthSearchInfo {
  const params = new URLSearchParams(rawSearch);
  const clientId = nonEmpty(params.get("client_id"));
  const signed = nonEmpty(params.get("sig")) !== null && params.getAll("ba_param").length > 0;
  return { clientId, usable: clientId !== null && signed };
}

/**
 * The only navigation signal the pages accept: a Better-Auth response with
 * `redirect === true` and a nonempty `url`.
 */
export function resolveOauthRedirectUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.redirect !== true) return null;
  return typeof record.url === "string" && record.url.length > 0 ? record.url : null;
}

/** Display-safe client data: the id and the name only (never the remote logo). */
export interface McpPublicClientInfo {
  clientId: string;
  name: string | null;
}

export function toMcpPublicClientInfo(data: unknown): McpPublicClientInfo | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const clientId = record.client_id ?? record.clientId;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  const name = record.client_name ?? record.name;
  return { clientId, name: typeof name === "string" && name.length > 0 ? name : null };
}

/**
 * Where the browser goes after the answer: the host of the SIGNED
 * `redirect_uri`, read the way the server will read it — or null (no
 * signature, `redirect_uri` not signed, missing or repeated, not a URL). A
 * non-web scheme shows itself, so an app link never passes for a website.
 */
export function signedRedirectHost(rawSearch: string): string | null {
  const params = new URLSearchParams(rawSearch);
  if (!params.get("sig")) return null;
  if (!params.getAll("ba_param").includes("redirect_uri")) return null;
  const values = params.getAll("redirect_uri");
  if (values.length !== 1 || !values[0]) return null;
  let url: URL;
  try {
    url = new URL(values[0]);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || url.protocol === "http:") return url.host || null;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/** A same-origin MCP page href that keeps the raw signed query byte for byte. */
export function mcpPageHref(
  lang: string,
  page: "mcp-login" | "mcp-consent",
  rawSearch: string,
): string {
  const query = rawSearch === "" || rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`;
  return `/${lang}/${page}${query}`;
}

/**
 * Whether a redirect host (as `signedRedirectHost` prints it) is this
 * computer: a coding agent such as Claude Code listens on
 * `localhost:<port>` for the answer.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}
