import type { AuthInfo } from "@modelcontextprotocol/server";

import type { McpIdentity } from "./credentials";

/**
 * Per-request binding from the verified `AuthInfo` to who the request acts
 * as (ported from ws-model-proxy's `mcp/tool-dispatch.ts`).
 *
 * `mcp/auth.ts` binds it after every admission check passes; the SDK hands
 * the same `AuthInfo` object, by reference, to the transport factory, which
 * registers the tools for that identity (`mcp/tools.ts`).
 *
 * - Keyed by object identity in a `WeakMap`: entries die with the request
 *   and cannot be looked up by a guessed key.
 * - An unbound `AuthInfo` resolves `undefined`, and every tool then fails
 *   closed: there is no path from an unverified request to a tool.
 * - The binding never holds the presented token.
 */
export interface McpToolDispatch {
  identity: McpIdentity;
  requestId: string;
  /** Aborted when the client disconnects or shutdown closes the admission gate. */
  signal: AbortSignal;
}

const dispatchByAuthInfo = new WeakMap<AuthInfo, McpToolDispatch>();

export function bindMcpToolDispatch(authInfo: AuthInfo, dispatch: McpToolDispatch): void {
  dispatchByAuthInfo.set(authInfo, dispatch);
}

export function resolveMcpToolDispatch(
  authInfo: AuthInfo | undefined,
): McpToolDispatch | undefined {
  return authInfo === undefined ? undefined : dispatchByAuthInfo.get(authInfo);
}
