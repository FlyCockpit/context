import { requireMcpAuth } from "@better-auth/mcp";
import { onUserBanned } from "@cockpit-context/auth/ban";
import {
  MCP_RESOURCE_SCOPE,
  MCP_RESOURCE_SCOPES,
  parseMcpScopes,
} from "@cockpit-context/auth/mcp-config";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Context } from "hono";

import { createMcpAdmissionGate, type McpAdmissionGate } from "./admission";
import {
  credentialKey,
  extractBearerToken,
  isAgentTokenSecret,
  type McpCredentialResult,
  type McpIdentity,
} from "./credentials";
import {
  errorClass,
  mcpForbiddenResponse,
  mcpInternalErrorResponse,
  mcpRequestAbortedResponse,
  mcpSanitizedLog,
  mcpShuttingDownResponse,
  mcpTooManyRequestsResponse,
  mcpUnauthorizedResponse,
} from "./errors";

/**
 * The `/mcp` POST handler (docs/mcp.md), adapted from
 * ws-model-proxy's `mcp/auth.ts`. Mounted after the method gate, the
 * pre-auth IP limiter and the body cap (`mcp/mount.ts`).
 *
 * 1. Take an admission permit (a 503 once shutdown began). The permit's
 *    signal is aborted by the client disconnecting and by shutdown, and it
 *    is the signal every tool waits on.
 * 2. Resolve the credential, in order:
 *    - `Authorization: Bearer cockpit_context_…`: an API token (`resolveAgentToken`);
 *    - any other bearer: an OAuth access token, verified by Better-Auth's
 *      `requireMcpAuth` (JWKS signature, issuer, audience
 *      `<BETTER_AUTH_URL>/mcp`, expiry, the `mcp` scope), then resolved to
 *      its live grant (`resolveOauthClaims`);
 *    - nothing: 401 with `WWW-Authenticate` naming the resource metadata.
 * 3. The per-identity request quota (verified identity only).
 * 4. Bind the identity to the `AuthInfo` and hand the request to the
 *    transport. The permit is held until the response body (an SSE stream
 *    while a tool reports progress) is finished or cancelled.
 *
 * The acting user is taken from the credential row only; nothing in the
 * JSON-RPC body can name a user.
 */

export type McpAuthInstance = Parameters<typeof requireMcpAuth>[0];

interface McpTransport {
  fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
}

export type McpQuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number };

interface McpVerifiedRequest {
  authInfo: AuthInfo;
  identity: McpIdentity;
  requestId: string;
  signal: AbortSignal;
}

export interface CreateMcpRequestHandlerOptions {
  authInstance: McpAuthInstance;
  transport: McpTransport;
  /** Canonical resource (`<BETTER_AUTH_URL>/mcp`): the token audience. */
  resourceUrl: string;
  /** Expected token issuer (`<BETTER_AUTH_URL>/api/auth`). */
  issuerUrl: string;
  /** Where the verifier fetches the signing keys (a loopback URL in production). */
  jwksUrl: string;
  /** Public origin the canonical request is rebuilt onto (DPoP `htu`). */
  publicOrigin: string;
  resolveAgentToken: (token: string, now: Date) => Promise<McpCredentialResult>;
  resolveOauthClaims: (claims: Record<string, unknown>, now: Date) => Promise<McpCredentialResult>;
  consumeIdentityQuota: (key: string) => Promise<McpQuotaResult>;
  onVerified: (verified: McpVerifiedRequest) => void;
  admissionGate?: McpAdmissionGate;
  now?: () => Date;
}

/**
 * The request rebuilt on the configured public origin (scheme and host from
 * `BETTER_AUTH_URL`; path, query, headers and body unchanged), carrying the
 * permit's signal. Behind a TLS-terminating proxy the socket is plain HTTP,
 * and DPoP proofs bind the public URL.
 */
function canonicalMcpRequest(raw: Request, publicOrigin: string, signal: AbortSignal) {
  const incoming = new URL(raw.url);
  const url = new URL(`${incoming.pathname}${incoming.search}`, publicOrigin);
  const init: RequestInit & { duplex?: "half" } = {
    method: raw.method,
    headers: raw.headers,
    signal,
  };
  if (raw.body !== null) {
    init.body = raw.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Wrap a response so `onDone` runs once its body is fully sent or cancelled.
 * When `endOn` aborts (the user was banned), the body is ended with an error
 * at once and the inner stream is cancelled, so a long SSE response stops.
 */
export function releaseWhenBodyEnds(
  response: Response,
  onDone: () => void,
  endOn?: AbortSignal,
): Response {
  if (response.body === null) {
    onDone();
    return response;
  }
  const reader = response.body.getReader();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    endOn?.removeEventListener("abort", end);
    onDone();
  };
  let end = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      end = () => {
        if (done) return;
        try {
          controller.error(endOn?.reason ?? new Error("MCP exchange ended"));
        } catch {
          // Already closed or errored.
        }
        void reader.cancel(endOn?.reason).catch(() => undefined);
        finish();
      };
      if (endOn?.aborted) end();
      else endOn?.addEventListener("abort", end, { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function refusalResponse(
  result: Extract<McpCredentialResult, { ok: false }>,
  resourceUrl: string,
): Response {
  return result.refusal === "forbidden"
    ? mcpForbiddenResponse()
    : mcpUnauthorizedResponse({
        description: "Invalid or expired credential",
        resourceUrl,
        scope: MCP_RESOURCE_SCOPE,
      });
}

export function createMcpRequestHandler(options: CreateMcpRequestHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const admissionGate = options.admissionGate ?? createMcpAdmissionGate();

  return async (c: Context): Promise<Response> => {
    const requestId = (c.get("requestId") as string | undefined) ?? "-";
    const clientSignal = c.req.raw.signal;
    if (clientSignal.aborted) return mcpRequestAbortedResponse();
    const admission = admissionGate.admit();
    if (admission === null) return mcpShuttingDownResponse();
    const owned = admission.controller;
    const onClientAbort = () => owned.abort();
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
    let handedOff = false;
    // Cancel-on-ban: once the identity is known, a ban of its user aborts the
    // exchange (tools and transport see `owned.signal`) and ends a streamed
    // body (`releaseWhenBodyEnds`). Admission re-checks the ban per request;
    // this covers the request already in flight (packages/auth/src/ban.ts).
    // The listener is registered BEFORE the credential is resolved (where the
    // ban is read): a ban announced between that read and the identity being
    // known is remembered and applied once it is.
    const banned = new AbortController();
    let exchangeUserId: string | undefined;
    const bannedBeforeIdentity = new Set<string>();
    const endForBan = () => {
      banned.abort(new Error("MCP user banned"));
      owned.abort();
    };
    const stopWatchingBan = onUserBanned((userId) => {
      if (exchangeUserId === undefined) bannedBeforeIdentity.add(userId);
      else if (userId === exchangeUserId) endForBan();
    });
    const release = () => {
      clientSignal.removeEventListener("abort", onClientAbort);
      stopWatchingBan();
      admission.release();
    };

    try {
      const signal = owned.signal;
      const request = canonicalMcpRequest(c.req.raw, options.publicOrigin, signal);

      const admitIdentity = async (result: McpCredentialResult, scopes: string[]) => {
        if (signal.aborted) return mcpRequestAbortedResponse();
        if (!result.ok) {
          mcpSanitizedLog(`rejected: ${result.reason}`, { requestId });
          return refusalResponse(result, options.resourceUrl);
        }
        const { identity } = result;
        exchangeUserId = identity.userId;
        if (bannedBeforeIdentity.has(identity.userId)) {
          endForBan();
          return mcpRequestAbortedResponse();
        }
        bannedBeforeIdentity.clear();
        const quota = await options.consumeIdentityQuota(credentialKey(identity.credential));
        if (!quota.ok) return mcpTooManyRequestsResponse(quota.retryAfterSeconds);
        if (signal.aborted) return mcpRequestAbortedResponse();
        const authInfo: AuthInfo = {
          // The SDK requires a token string; the bound identity is what the
          // tools read. The presented credential never reaches a tool.
          token: "[verified]",
          clientId:
            identity.credential.kind === "oauth"
              ? identity.credential.clientId
              : `token:${identity.credential.tokenId}`,
          scopes,
          resource: new URL(options.resourceUrl),
        };
        options.onVerified({ authInfo, identity, requestId, signal });
        return options.transport.fetch(request, { authInfo });
      };

      const bearer = extractBearerToken(request.headers.get("authorization"));
      let response: Response;
      if (bearer !== null && isAgentTokenSecret(bearer)) {
        response = await admitIdentity(await options.resolveAgentToken(bearer, now()), [
          MCP_RESOURCE_SCOPE,
        ]);
      } else {
        // Missing, non-bearer and OAuth credentials all go through the
        // upstream verifier, which answers the RFC 9728 challenge itself.
        const verified = requireMcpAuth(
          options.authInstance,
          async (_verifiedRequest, claims) => {
            const scopes = parseMcpScopes(
              typeof claims.scope === "string" || Array.isArray(claims.scope)
                ? (claims.scope as string | string[])
                : null,
            );
            return admitIdentity(
              await options.resolveOauthClaims(claims as Record<string, unknown>, now()),
              scopes,
            );
          },
          {
            issuer: options.issuerUrl,
            resource: options.resourceUrl,
            jwksUrl: options.jwksUrl,
            requiredScopes: [MCP_RESOURCE_SCOPE],
            challengeScopes: MCP_RESOURCE_SCOPES,
          },
        );
        response = await verified(request);
      }
      if (signal.aborted && response.body === null) return mcpRequestAbortedResponse();
      handedOff = true;
      // Merge through Hono so headers set earlier in the chain survive.
      const held = releaseWhenBodyEnds(response, release, banned.signal);
      return c.newResponse(held.body, held);
    } catch (error) {
      mcpSanitizedLog(`internal error (${errorClass(error)})`, { requestId });
      return mcpInternalErrorResponse({ requestId });
    } finally {
      if (!handedOff) release();
    }
  };
}
