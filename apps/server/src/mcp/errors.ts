/**
 * Safe `/mcp` error responses and the sanitized log line (ported from
 * ws-model-proxy's `mcp/errors.ts`).
 *
 * - 401 (missing or invalid credentials): `WWW-Authenticate: Bearer
 *   error="invalid_token", resource_metadata="<origin>/.well-known/
 *   oauth-protected-resource/mcp", …` (RFC 6750 §3 + RFC 9728), so an MCP
 *   client can discover the authorization server and start OAuth.
 * - 403 for a denial re-authorizing cannot fix (revoked grant, banned user):
 *   no challenge and a generic body; the reason goes to the log only.
 *
 * Bodies use the JSON-RPC error shape (`{jsonrpc, error: {code, message},
 * id: null}`), the same grammar as the upstream verifier's challenges.
 *
 * Logs carry a static reason plus verified ids and the request id, never
 * tokens, arguments, or error messages from Prisma/Better-Auth internals.
 */

const INTERNAL_ERROR_JSONRPC_CODE = -32603;
const AUTHORIZATION_ERROR_JSONRPC_CODE = -32000;
const MAX_DESCRIPTION_LENGTH = 120;

function quoteAuthParam(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * RFC 9728 protected-resource metadata URL for a resource, derived the way
 * the upstream challenge builder derives it:
 * `<origin>/.well-known/oauth-protected-resource<resource path>`.
 */
export function mcpResourceMetadataUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

function jsonRpcError(code: number, message: string, data?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message, ...(data ? { data } : {}) },
    id: null,
  });
}

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 401 with the RFC 6750 + RFC 9728 challenge pointing at the resource metadata. */
export function mcpUnauthorizedResponse({
  description,
  resourceUrl,
  scope,
}: {
  description: string;
  resourceUrl: string;
  /** Scopes the client should request (the challenge's `scope` hint). */
  scope?: string;
}): Response {
  const params = [
    'error="invalid_token"',
    `resource_metadata="${quoteAuthParam(mcpResourceMetadataUrl(resourceUrl))}"`,
    ...(scope ? [`scope="${quoteAuthParam(scope)}"`] : []),
    `error_description="${quoteAuthParam(description.slice(0, MAX_DESCRIPTION_LENGTH))}"`,
  ].join(", ");
  return jsonResponse(401, jsonRpcError(AUTHORIZATION_ERROR_JSONRPC_CODE, "Unauthorized"), {
    "WWW-Authenticate": `Bearer ${params}`,
  });
}

/** 403 a re-authorization cannot fix: no challenge, no reason. */
export function mcpForbiddenResponse(): Response {
  return jsonResponse(403, jsonRpcError(AUTHORIZATION_ERROR_JSONRPC_CODE, "Forbidden"));
}

/** Unexpected failure: a generic internal error with the request id for correlation. */
export function mcpInternalErrorResponse({ requestId }: { requestId: string }): Response {
  return jsonResponse(
    500,
    jsonRpcError(INTERNAL_ERROR_JSONRPC_CODE, "Internal error", { requestId }),
  );
}

/** 503 once shutdown closed the admission gate. */
export function mcpShuttingDownResponse(): Response {
  return jsonResponse(
    503,
    jsonRpcError(AUTHORIZATION_ERROR_JSONRPC_CODE, "Server is shutting down"),
    { "Retry-After": "5" },
  );
}

/** 499: the client went away, or shutdown cancelled the exchange. */
export function mcpRequestAbortedResponse(): Response {
  return jsonResponse(499, jsonRpcError(AUTHORIZATION_ERROR_JSONRPC_CODE, "Client closed request"));
}

/** 429 for the per-identity request quota. */
export function mcpTooManyRequestsResponse(retryAfterSeconds: number): Response {
  return jsonResponse(429, jsonRpcError(AUTHORIZATION_ERROR_JSONRPC_CODE, "Too many requests"), {
    "Retry-After": String(retryAfterSeconds),
  });
}

// Any character that can carry URL, path, query, header or JSON structure, or
// a control character. A CIMD client id is a URL whose query may carry
// credentials, so a field containing any of these is logged as `[redacted]`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character class is part of the trigger.
const UNTRUSTED_STRUCTURE = /[/?#:=@{}"'`%\\\s]|[\x00-\x1f\x7f]/;

function safeLogField(value: string): string {
  return UNTRUSTED_STRUCTURE.test(value) ? "[redacted]" : value.slice(0, 128);
}

/**
 * The one `/mcp` log line: a static reason, then verified ids (each
 * redacted whole when it carries structure). Never a token, an argument or an
 * error object.
 */
export function mcpSanitizedLog(
  reason: string,
  fields: { userId?: string; clientId?: string; requestId?: string; toolName?: string } = {},
): void {
  const parts = [`[mcp] ${reason}`];
  if (fields.userId) parts.push(`user=${safeLogField(fields.userId)}`);
  if (fields.clientId) parts.push(`client=${safeLogField(fields.clientId)}`);
  if (fields.requestId) parts.push(`request=${safeLogField(fields.requestId)}`);
  if (fields.toolName) parts.push(`tool=${safeLogField(fields.toolName)}`);
  console.error(parts.join(" "));
}

/** The class name of a thrown value, for sanitized logs. */
export function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
