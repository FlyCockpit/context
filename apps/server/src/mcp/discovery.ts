import type { Context, MiddlewareHandler } from "hono";

/**
 * OAuth discovery for MCP clients (ported from ws-model-proxy's
 * `mcp-discovery.ts`). The `mcp()` and oauth-provider plugins serve all four
 * documents from the Better-Auth handler's `onRequest` hooks, so these
 * routes forward the request unchanged:
 *
 * - `/.well-known/oauth-protected-resource[/mcp]` — RFC 9728 resource
 *   metadata (`resource`, `authorization_servers`, `scopes_supported`);
 * - `/.well-known/oauth-authorization-server/api/auth` and
 *   `/api/auth/.well-known/oauth-authorization-server` — RFC 8414
 *   authorization-server metadata for the issuer `<origin>/api/auth`
 *   (endpoints, PKCE, the RFC 7591 `registration_endpoint`, CIMD support).
 *
 * GET forwards; HEAD runs the GET and drops the body; anything else is 405
 * `Allow: GET, HEAD`. Mounted before CORS and the auth limiters, so these
 * reads never spend an auth budget and never fall through to the SPA.
 */
export const MCP_WELL_KNOWN_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

/**
 * The request rebuilt on the configured public origin with no body, so
 * every URL in the documents comes from configuration, never from the
 * request's Host header.
 */
function onPublicOrigin(raw: Request, publicOrigin: string, method = raw.method): Request {
  const incoming = new URL(raw.url);
  return new Request(new URL(`${incoming.pathname}${incoming.search}`, publicOrigin), {
    method,
    headers: { accept: raw.headers.get("accept") ?? "application/json" },
  });
}

export function createMcpDiscoveryForwarder(options: {
  publicOrigin: string;
  handler: (request: Request, c: Context) => Response | Promise<Response>;
}): MiddlewareHandler {
  return async (c) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return c.newResponse(null, 405, { Allow: "GET, HEAD" });
    }
    const request = onPublicOrigin(c.req.raw, options.publicOrigin, "GET");
    const response = await options.handler(request, c);
    if (method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  };
}
