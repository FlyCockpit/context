import { createHmac } from "node:crypto";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import prisma from "@cockpit-context/db";

/**
 * Application-owned MCP grant generations (`McpGrant`), ported from
 * ws-model-proxy's `mcp-grant.ts`.
 *
 * Better-Auth owns the OAuth protocol; this module owns Cockpit Context's
 * per-connection row:
 *
 * - `postLogin.consentReferenceId` derives a fixed-length HMAC reference from
 *   the Better-Auth session id plus the client id inside the signed
 *   `oauth_query` (read through `getOAuthProviderState()`). It throws when
 *   the reference cannot be derived (the upstream contract).
 * - The access-token claims extension creates the grant when absent (an
 *   approval on the consent page has normally created it already, with the
 *   person's flags — `mcp-consent-flags.ts`), reuses it while active, and
 *   REJECTS a tombstone on authorization-code exchange. On refresh the exact
 *   grant must still be active. The immutable grant id is stamped as the
 *   private `mcp_grant_id` JWT claim, which `/mcp` resolves on every request.
 * - Nothing here writes `revokedAt`: only a person's revoke
 *   (`mcpConnections.revoke`) sets it, and a tombstone is never cleared. A new
 *   session (sign in again) is a new reference and so a new grant.
 */

/** Private JWT claim carrying the immutable McpGrant row id. */
export const MCP_GRANT_ID_CLAIM = "mcp_grant_id";

const CONSENT_REFERENCE_DOMAIN = "cockpit-context:mcp-consent-reference:v1";

/** Deterministic hex HMAC binding a session id to a signed OAuth client id. */
export function deriveMcpConsentReferenceId({
  secret,
  sessionId,
  clientId,
}: {
  secret: string;
  sessionId: string;
  clientId: string;
}): string {
  return createHmac("sha256", secret)
    .update(`${CONSENT_REFERENCE_DOMAIN}\0${sessionId}\0${clientId}`)
    .digest("hex");
}

export interface McpGrantRecord {
  id: string;
  userId: string;
  clientId: string;
  referenceId: string;
  revokedAt: Date | null;
}

export type McpGrantRejectReason =
  | "missing-user"
  | "missing-session"
  | "tombstone"
  | "inactive-on-refresh";

export type McpGrantDecision =
  | { action: "create" }
  | { action: "reuse"; grant: McpGrantRecord }
  | { action: "reject"; reason: McpGrantRejectReason };

export class McpGrantError extends Error {
  readonly reason: McpGrantRejectReason;
  constructor(reason: McpGrantRejectReason, message: string) {
    super(message);
    this.name = "McpGrantError";
    this.reason = reason;
  }
}

/**
 * Pure decision for a token issuance. `existing` is the row found by the
 * exact `(userId, clientId, referenceId)` key, or null.
 */
export function resolveMcpGrantDecision({
  grantType,
  userId,
  referenceId,
  existing,
}: {
  grantType: "authorization_code" | "refresh_token";
  userId: string | undefined;
  referenceId: string | undefined;
  existing: McpGrantRecord | null;
}): McpGrantDecision {
  if (!userId) return { action: "reject", reason: "missing-user" };
  if (!referenceId) return { action: "reject", reason: "missing-session" };
  if (grantType === "authorization_code") {
    if (existing === null) return { action: "create" };
    if (existing.revokedAt === null) return { action: "reuse", grant: existing };
    return { action: "reject", reason: "tombstone" };
  }
  if (existing === null) return { action: "reject", reason: "inactive-on-refresh" };
  if (existing.revokedAt !== null) return { action: "reject", reason: "tombstone" };
  return { action: "reuse", grant: existing };
}

const GRANT_SELECT = {
  id: true,
  userId: true,
  clientId: true,
  referenceId: true,
  revokedAt: true,
} as const;

/**
 * A grant-storage failure is logged as one line with the operation and the
 * error class only (Prisma messages carry SQL and parameters), then replaced
 * by a generic error so issuance fails closed.
 */
async function sanitizedGrantStorage<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(
      `[mcp-grant] ${operation} failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
    );
    throw new Error("MCP grant storage failure");
  }
}

function findGrantByReference(
  userId: string,
  clientId: string,
  referenceId: string,
): Promise<McpGrantRecord | null> {
  return sanitizedGrantStorage("findGrantByReference", () =>
    prisma.mcpGrant.findUnique({
      where: { userId_clientId_referenceId: { userId, clientId, referenceId } },
      select: GRANT_SELECT,
    }),
  );
}

/**
 * Grant check plus the `mcp_grant_id` claim for one token issuance. The
 * hook-supplied `referenceId` (the consent HMAC Better-Auth persisted) is
 * authoritative; the session-derived HMAC is only a fallback when minting
 * from an authorization code. Refresh and introspection without a reference
 * fail closed: never fall back to another active generation.
 *
 * - `authorization_code` / `refresh_token`: create / reuse / reject per
 *   {@link resolveMcpGrantDecision}.
 * - undefined (opaque-token introspection): read-only, the exact grant must
 *   exist and be active.
 */
export async function issueMcpGrantClaims({
  grantType,
  userId,
  clientId,
  referenceId,
  sessionId,
  secret,
}: {
  grantType: string | undefined;
  userId: string | undefined;
  clientId: string;
  referenceId?: string | undefined;
  sessionId?: string | null | undefined;
  secret: string;
}): Promise<Record<string, unknown>> {
  if (!userId) throw new McpGrantError("missing-user", "MCP grant requires an authenticated user");
  const reference =
    referenceId ??
    (grantType === "authorization_code" && sessionId != null
      ? deriveMcpConsentReferenceId({ secret, sessionId, clientId })
      : undefined);
  if (reference === undefined) {
    throw new McpGrantError("missing-session", "MCP grant requires the durable consent reference");
  }

  if (grantType === "authorization_code" || grantType === "refresh_token") {
    const existing = await findGrantByReference(userId, clientId, reference);
    const decision = resolveMcpGrantDecision({
      grantType,
      userId,
      referenceId: reference,
      existing,
    });
    if (decision.action === "reject") {
      throw new McpGrantError(
        decision.reason,
        `MCP grant decision rejected token issuance: ${decision.reason}`,
      );
    }
    if (decision.action === "reuse") return { [MCP_GRANT_ID_CLAIM]: decision.grant.id };
    const clientName = await sanitizedGrantStorage("findClientName", () =>
      prisma.oauthClient.findUnique({ where: { clientId }, select: { name: true } }),
    );
    // `skipDuplicates`: a racing creation (the consent hook) is not an error;
    // the row is then read like any other.
    await sanitizedGrantStorage("createMcpGrant", () =>
      prisma.mcpGrant.createMany({
        data: [{ userId, clientId, referenceId: reference, clientName: clientName?.name ?? null }],
        skipDuplicates: true,
      }),
    );
    const created = await findGrantByReference(userId, clientId, reference);
    if (created === null || created.revokedAt !== null) {
      throw new McpGrantError("tombstone", "MCP grant is not active");
    }
    return { [MCP_GRANT_ID_CLAIM]: created.id };
  }

  const exact = await findGrantByReference(userId, clientId, reference);
  if (exact !== null && exact.revokedAt === null) return { [MCP_GRANT_ID_CLAIM]: exact.id };
  throw new McpGrantError("inactive-on-refresh", "No active MCP grant generation for token claims");
}

/** Minimal structural context the postLogin callbacks receive. */
export interface McpPostLoginContext {
  user?: { id?: string | undefined } | undefined;
  session?: { id?: string | undefined } | undefined;
}

/**
 * The client id Better-Auth already validated inside the signed query, or
 * null (also outside a request context, where the state store throws).
 */
export async function validatedClientIdFromOAuthState(): Promise<string | null> {
  let query: string | undefined;
  try {
    query = (await getOAuthProviderState())?.query;
  } catch {
    return null;
  }
  if (!query) return null;
  const clientId = new URLSearchParams(query).get("client_id");
  return clientId && clientId.length > 0 ? clientId : null;
}

/** Whether the exact (user, client, reference) generation is a tombstone. */
export async function isMcpGrantGenerationTombstoned(input: {
  userId: string;
  clientId: string;
  referenceId: string;
}): Promise<boolean> {
  const grant = await findGrantByReference(input.userId, input.clientId, input.referenceId);
  return grant?.revokedAt != null;
}

/** The `postLogin` option object `mcp()` consumes (mcp-plugins.ts). */
export function createMcpPostLoginOptions({
  secret,
  loginPage,
}: {
  secret: string;
  loginPage: string;
}) {
  return {
    page: loginPage,
    consentReferenceId: async (context: McpPostLoginContext): Promise<string> => {
      const sessionId = context.session?.id;
      const clientId = await validatedClientIdFromOAuthState();
      if (!sessionId || !clientId) {
        throw new Error("MCP consent reference unavailable: session or signed client missing");
      }
      return deriveMcpConsentReferenceId({ secret, sessionId, clientId });
    },
    /**
     * Send the browser back to the MCP login page exactly when this session's
     * grant generation for the client was revoked, so the person signs in
     * again (a new session is a new generation).
     */
    shouldRedirect: async (context: McpPostLoginContext): Promise<boolean> => {
      const userId = context.user?.id;
      const sessionId = context.session?.id;
      if (!userId || !sessionId) return false;
      const clientId = await validatedClientIdFromOAuthState();
      if (!clientId) return false;
      const referenceId = deriveMcpConsentReferenceId({ secret, sessionId, clientId });
      return isMcpGrantGenerationTombstoned({ userId, clientId, referenceId });
    },
  };
}
