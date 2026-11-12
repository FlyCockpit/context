import { createFileRoute } from "@tanstack/react-router";

import { McpLoginPage } from "@/components/mcp/mcp-login-page";

/**
 * MCP OAuth login (docs/mcp.md): where Better-Auth sends an
 * authorization that has no session. The whole search passes through
 * untouched — the signed OAuth parameters are the transaction — and the page
 * reads the RAW `window.location.search` (TanStack re-serializes search).
 */
export const Route = createFileRoute("/$lang/_app/mcp-login")({
  validateSearch: (search: Record<string, unknown>) => search,
  component: McpLoginRoute,
});

function McpLoginRoute() {
  const { lang } = Route.useParams();
  // Raw, like mcp-consent: the signed OAuth query must survive byte for byte.
  const rawSearch = typeof window === "undefined" ? "" : window.location.search;
  return <McpLoginPage lang={lang} rawSearch={rawSearch} />;
}
