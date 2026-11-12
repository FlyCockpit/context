import { createFileRoute, redirect } from "@tanstack/react-router";

import { McpConsentPage } from "@/components/mcp/mcp-consent-page";
import { mcpPageHref } from "@/lib/mcp-oauth-search";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * MCP OAuth consent (docs/mcp.md). Requires a session: an anonymous
 * visitor goes to the MCP login page with the signed query preserved byte
 * for byte (a document navigation built from the raw query, because the
 * router would re-serialize it and break the signature).
 */
export const Route = createFileRoute("/$lang/_app/mcp-consent")({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: async ({ params }) => {
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      throw redirect({
        href: mcpPageHref(params.lang, "mcp-login", window.location.search),
        reloadDocument: true,
      });
    }
  },
  component: McpConsentRoute,
});

function McpConsentRoute() {
  // The signed OAuth query must reach Better-Auth byte for byte, so it is read
  // raw from the address bar, not from the router's re-serialized search. The
  // `_app` branch never server-renders (`ssr: false`); the guard keeps it so.
  const rawSearch = typeof window === "undefined" ? "" : window.location.search;
  return <McpConsentPage rawSearch={rawSearch} />;
}
