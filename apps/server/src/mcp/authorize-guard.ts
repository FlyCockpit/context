import { canonicalMcpResource } from "@cockpit-context/auth/mcp-config";
import type { MiddlewareHandler } from "hono";

/**
 * Local boundary in front of `/api/auth/oauth2/authorize` (ported from
 * ws-model-proxy's `mcp-authorize-scope-guard.ts`).
 *
 * Better-Auth 1.7 has no default scope, and it reports a protocol error by
 * redirecting to the caller's still-unvalidated `redirect_uri`. So an
 * authorize request with a missing or blank `scope`, or one whose
 * `resource` (RFC 8707) does not name this server's canonical MCP resource
 * (`<BETTER_AUTH_URL>/mcp`), is refused HERE with a plain 400 that never
 * uses the redirect. Every other request is forwarded unchanged, so
 * Better-Auth validates the client, redirect URI and scope values first.
 *
 * The parsing replicates what the downstream consumer reads (better-call's
 * body parsing: the LAST form value per key, the JSON branch for
 * `application/…+json` hybrids; repeated GET `scope` keys left to
 * downstream), and the body is inspected through `request.clone()` only.
 * The guard fires only when the RAW pathname is exactly the authorize path:
 * better-call routes on the raw pathname, Hono's `c.req.path` decodes it.
 */

export const MCP_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

/** Boundary verdict for one authorize request. */
export type AuthorizeBoundaryDecision =
  | "forward"
  | "not-applicable"
  | "invalid-scope"
  | "invalid-target"
  | "invalid-request";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
/** better-call getBody: JSON is matched on the FULL normalized content type. */
const JSON_CONTENT_TYPE_REGEX = /^application\/([a-z0-9.+-]*\+)?json/i;

/** better-call getBody allowlist: base (before `;`) INCLUDES the form type. */
function contentTypeBase(contentType: string | null): string {
  return (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

function isFormAdmissible(contentType: string | null): boolean {
  return contentTypeBase(contentType).includes(FORM_CONTENT_TYPE);
}

function isJsonBranch(contentType: string | null): boolean {
  return (
    isFormAdmissible(contentType) && JSON_CONTENT_TYPE_REGEX.test((contentType ?? "").toLowerCase())
  );
}

function isBlankScope(scope: string | null | undefined): boolean {
  return scope == null || scope.trim().length === 0;
}

/**
 * Whether a requested resource set contains the canonical MCP resource
 * (membership — used for the schema-legitimate list shapes: repeated GET
 * query occurrences and JSON-branch arrays).
 */
function requestedResourcesIncludeCanonical(
  resources: readonly string[],
  baseUrl: string,
): boolean {
  return resources.includes(canonicalMcpResource(baseUrl));
}

function inspectQuery(params: URLSearchParams, canonical: string): AuthorizeBoundaryDecision {
  // scope: exactly one occurrence may be judged locally; repeats are left to
  // downstream's "must not appear more than once" invalid_request redirect.
  const scopes = params.getAll("scope");
  if (scopes.length > 1) return "forward";
  if (scopes.length === 0 || isBlankScope(scopes[0])) return "invalid-scope";
  const resources = params.getAll("resource");
  if (resources.length === 0) return "invalid-target";
  if (resources.length === 1) {
    return resources[0] === canonical ? "forward" : "invalid-target";
  }
  return requestedResourcesIncludeCanonical(resources, canonical) ? "forward" : "invalid-target";
}

function inspectJsonObject(
  body: Record<string, unknown>,
  canonical: string,
): AuthorizeBoundaryDecision {
  const scope = body.scope;
  if (scope === undefined || (typeof scope === "string" && isBlankScope(scope))) {
    return "invalid-scope";
  }
  if (typeof scope !== "string") return "forward"; // downstream invalid_request
  const resource = body.resource;
  if (resource === undefined) return "invalid-target";
  if (typeof resource === "string") {
    return resource === canonical ? "forward" : "invalid-target";
  }
  if (Array.isArray(resource)) {
    return requestedResourcesIncludeCanonical(
      resource.filter((entry): entry is string => typeof entry === "string"),
      canonical,
    )
      ? "forward"
      : "invalid-target";
  }
  return "forward"; // non-string non-array: downstream invalid_request
}

async function inspectFormPost(
  request: Request,
  canonical: string,
): Promise<AuthorizeBoundaryDecision> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // The content type passed the substring allowlist but undici refuses to
    // form-parse it (e.g. `text/application/x-www-form-urlencoded`). Judge
    // it HERE: forwarding would let downstream's formData() throw the same
    // TypeError as a non-APIError → 500 + raw-TypeError log. Local 400
    // invalid_request, non-redirecting (RFC 6749 §5.2 malformed request).
    return "invalid-request";
  }
  // LAST value per key, in iteration order — exactly better-call's
  // `formData().forEach((value, key) => { result[key] = value.toString(); })`.
  const last = new Map<string, string>();
  for (const [key, value] of form.entries()) {
    last.set(key, value.toString());
  }
  const scope = last.get("scope");
  if (scope === undefined || isBlankScope(scope)) return "invalid-scope";
  const resource = last.get("resource");
  if (resource === undefined) return "invalid-target";
  return resource === canonical ? "forward" : "invalid-target";
}

async function inspectJsonPost(
  request: Request,
  canonical: string,
): Promise<AuthorizeBoundaryDecision> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return "not-applicable"; // downstream: 400 invalid JSON on the same bytes
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "forward"; // downstream body validation rejects non-objects
  }
  return inspectJsonObject(body as Record<string, unknown>, canonical);
}

/**
 * Judge an authorize request's `scope` and `resource` parameters against
 * the pinned downstream semantics without consuming its body.
 * `"not-applicable"` means the method/content-type combination is not one
 * the boundary governs — forwarded for Better Auth to answer (415).
 */
export async function inspectAuthorizeRequest(
  request: Request,
  baseUrl: string,
): Promise<AuthorizeBoundaryDecision> {
  const canonical = canonicalMcpResource(baseUrl);
  // GET only: the provider registers GET/POST handlers, so better-call's
  // findRoute 404s a HEAD authorize request. Judging HEAD here would fire
  // the boundary on a request downstream never serves (L18 applicability:
  // the guard must never be broader than the route it fronts) — HEAD is
  // not-applicable → forwarded → downstream 404.
  if (request.method === "GET") {
    return inspectQuery(new URL(request.url).searchParams, canonical);
  }
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type");
    if (!isFormAdmissible(contentType)) return "not-applicable";
    if (isJsonBranch(contentType)) return inspectJsonPost(request, canonical);
    return inspectFormPost(request, canonical);
  }
  return "not-applicable";
}

function authorizationErrorBody(error: string, errorDescription: string): Response {
  return new Response(JSON.stringify({ error, error_description: errorDescription }), {
    status: 400,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * RFC 6749 §5.2-style error response for the invalid scope: 400,
 * `application/json; charset=utf-8`, no-store (§5.1). Delivered directly to
 * the caller — the caller's redirect_uri is NEVER used (it is unvalidated at
 * this point).
 */
function invalidAuthorizeScopeResponse(): Response {
  return authorizationErrorBody(
    "invalid_scope",
    "The authorization request must specify a non-empty scope.",
  );
}

/**
 * RFC 9207/RFC 8707-style error response when the requested resource set is
 * missing or does not include this server's canonical MCP resource. Same
 * local, non-redirecting shape as the scope rejection.
 */
function invalidAuthorizeTargetResponse(): Response {
  return authorizationErrorBody(
    "invalid_target",
    "The authorization request must include this server's MCP resource in the resource parameter.",
  );
}

/**
 * RFC 6749 §5.2-style error response for a form-admissible body that cannot
 * be form-parsed at all (exotic content types like
 * `text/application/x-www-form-urlencoded` that pass better-call's substring
 * allowlist but are refused by the body parser). Same local,
 * non-redirecting shape as the other rejections.
 */
function invalidAuthorizeRequestResponse(): Response {
  return authorizationErrorBody(
    "invalid_request",
    "The authorization request body could not be parsed.",
  );
}

/** Mounted on `/api/auth/oauth2/authorize` before the Better-Auth handler. */
export function createMcpAuthorizeGuard(baseUrl: string): MiddlewareHandler {
  return async (c, next) => {
    if (new URL(c.req.raw.url).pathname !== MCP_AUTHORIZE_PATH) return next();
    const decision = await inspectAuthorizeRequest(c.req.raw, baseUrl);
    if (decision === "invalid-scope") return invalidAuthorizeScopeResponse();
    if (decision === "invalid-target") return invalidAuthorizeTargetResponse();
    if (decision === "invalid-request") return invalidAuthorizeRequestResponse();
    return next();
  };
}
