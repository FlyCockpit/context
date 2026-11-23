/**
 * The keepalive of every long-lived response this server streams: MCP tool
 * calls (`mcp/handler.ts`) and the web live view (`conversations.watch` /
 * `.activity` through the oRPC handler in `index.ts`). Each sends an SSE
 * comment at this interval whatever the run or the model is doing, so a
 * proxy that ends a response after a period without a byte never sees a
 * silent stream: Cloudflare documents a 125 s origin read timeout (524), and
 * 100 s is the budget planned for (docs/deploy.md § Home server behind a
 * Cloudflare Tunnel).
 */
export const STREAM_KEEPALIVE_MS = 15_000;

/**
 * The oRPC fetch adapter's event-iterator options, set explicitly (the
 * library's own defaults are a 5 s interval and an empty comment).
 */
export const RPC_EVENT_STREAM_OPTIONS = {
  eventIteratorKeepAliveEnabled: true,
  eventIteratorKeepAliveInterval: STREAM_KEEPALIVE_MS,
  eventIteratorKeepAliveComment: "keepalive",
} as const;
