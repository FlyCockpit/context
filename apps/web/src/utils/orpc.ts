import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { ORPC_BATCH_MAX_SIZE } from "@cockpit-context/config/orpc-batch";
import { env } from "@cockpit-context/env/web";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  BatchLinkPlugin,
  ClientRetryPlugin,
  DedupeRequestsPlugin,
  SimpleCsrfProtectionLinkPlugin,
} from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

/**
 * Event-iterator procedures: one long-lived streamed response each. A batch
 * would hold them (and every query batched with them) until the stream
 * ends, so they always travel on their own request.
 */
const STREAMING_PROCEDURES = new Set(["conversations.watch", "conversations.activity"]);

const link = new RPCLink({
  url: `${env.VITE_SERVER_URL}/rpc`,
  plugins: [
    new SimpleCsrfProtectionLinkPlugin(),
    // `maxSize` must stay in sync with the server's `BatchHandlerPlugin` —
    // pass the shared constant on both sides, never a literal. A client value
    // above the server's makes the server 413 the whole batch. See
    // `packages/config/src/orpc-batch.ts`.
    new BatchLinkPlugin({
      groups: [{ condition: () => true, context: {} }],
      maxSize: ORPC_BATCH_MAX_SIZE,
      exclude: ({ path }) => STREAMING_PROCEDURES.has(path.join(".")),
    }),
    new DedupeRequestsPlugin({ groups: [{ condition: () => true, context: {} }] }),
    // ClientRetryPlugin only retries procedures that explicitly opt in via
    // `context: { retry: N }`. No procedure in this app opts in, so 429s are
    // never silently retried here — the global error handler in router.tsx
    // surfaces them as a friendly toast instead.
    new ClientRetryPlugin(),
  ],
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: "include",
    });
  },
});

const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
