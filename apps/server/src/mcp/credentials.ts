import { isUserBanned } from "@cockpit-context/auth/ban";
import { MCP_GRANT_ID_CLAIM } from "@cockpit-context/auth/mcp-grant";
import type defaultPrisma from "@cockpit-context/db";
import type { Prisma } from "@cockpit-context/db";
import {
  isMcpAgentToken,
  mcpAgentTokenLookupPrefix,
  verifyMcpAgentTokenDigest,
} from "@cockpit-context/db/mcp-agent-token";

/**
 * Resolving an `/mcp` credential to the user it acts for and the
 * connection's flags (docs/mcp.md). The user and the flags
 * come from the credential's row — never from request or tool input.
 *
 * - API token (`Bearer cockpit_context_…`): the row found by lookup prefix whose HMAC
 *   digest matches in constant time; revoked or expired is refused.
 * - OAuth access token: the JWT is verified upstream (signature, issuer,
 *   audience `<BETTER_AUTH_URL>/mcp`, expiry); here its private
 *   `mcp_grant_id` claim must name an active `McpGrant` of the same user and
 *   client.
 *
 * `lastUsedAt` is stamped at most once a minute per credential (best
 * effort; a failure never refuses the request).
 */

const MCP_LAST_USED_TOUCH_INTERVAL_MS = 60_000;

export type McpCredential =
  | { kind: "agent_token"; tokenId: string }
  | { kind: "oauth"; grantId: string; clientId: string };

/** Who an `/mcp` request acts as, and what the connection may do. */
export interface McpIdentity {
  userId: string;
  credential: McpCredential;
  /** Token name or OAuth client name: the connection's display label. */
  label: string;
  allowPropose: boolean;
  autoApprove: boolean;
}

export type McpCredentialPrisma = {
  mcpAgentToken: Pick<typeof defaultPrisma.mcpAgentToken, "findUnique" | "updateMany">;
  mcpGrant: Pick<typeof defaultPrisma.mcpGrant, "findUnique" | "updateMany">;
};

/**
 * The credential's owner, read in the same query as the credential (one
 * relation join) for the ban check. `User` is a required relation with a
 * cascading delete, so a credential row never outlives its user.
 */
const credentialUserSelect = {
  select: { id: true, banned: true, banExpires: true },
} satisfies Prisma.UserDefaultArgs;

const agentTokenSelect = {
  id: true,
  userId: true,
  name: true,
  secretDigest: true,
  allowPropose: true,
  autoApprove: true,
  revokedAt: true,
  expiresAt: true,
  lastUsedAt: true,
  User: credentialUserSelect,
} satisfies Prisma.McpAgentTokenSelect;

const grantSelect = {
  id: true,
  userId: true,
  clientId: true,
  clientName: true,
  allowPropose: true,
  autoApprove: true,
  revokedAt: true,
  lastUsedAt: true,
  User: credentialUserSelect,
} satisfies Prisma.McpGrantSelect;

/** Why a credential was refused: `unauthorized` → 401 + challenge, `forbidden` → 403. */
type McpCredentialRefusal = "unauthorized" | "forbidden";

export type McpCredentialResult =
  | { ok: true; identity: McpIdentity }
  | { ok: false; refusal: McpCredentialRefusal; reason: string };

/** Stable key of one credential, for rate limits and in-flight tracking. */
export function credentialKey(credential: McpCredential): string {
  return credential.kind === "agent_token"
    ? `token:${credential.tokenId}`
    : `grant:${credential.grantId}`;
}

/** The `Authorization: Bearer <token>` value, or null. DPoP and other schemes are not bearer. */
export function extractBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^(\S+)\s+(\S+)$/.exec(header);
  if (match?.[1]?.toLowerCase() !== "bearer") return null;
  return match[2] ?? null;
}

export function isAgentTokenSecret(token: string): boolean {
  return isMcpAgentToken(token);
}

function touchThreshold(now: Date): Date {
  return new Date(now.getTime() - MCP_LAST_USED_TOUCH_INTERVAL_MS);
}

/**
 * Whether the row's stamp is old enough to rewrite. Checked on the row already
 * read so a fresh stamp costs no write; the update's own guard still settles races.
 */
function isTouchDue(lastUsedAt: Date | null, now: Date): boolean {
  return !lastUsedAt || lastUsedAt.getTime() < touchThreshold(now).getTime();
}

/** Verify a `cockpit_context_` API token. */
export async function resolveAgentToken(
  token: string,
  { prisma, secret, now }: { prisma: McpCredentialPrisma; secret: string; now: Date },
): Promise<McpCredentialResult> {
  if (!isMcpAgentToken(token)) {
    return { ok: false, refusal: "unauthorized", reason: "not an API token" };
  }
  const row = await prisma.mcpAgentToken.findUnique({
    where: { lookupPrefix: mcpAgentTokenLookupPrefix(token) },
    select: agentTokenSelect,
  });
  // One answer for unknown, wrong, revoked and expired: nothing to probe.
  if (!row || !verifyMcpAgentTokenDigest(token, row.secretDigest, secret)) {
    return { ok: false, refusal: "unauthorized", reason: "unknown API token" };
  }
  if (row.revokedAt !== null) {
    return { ok: false, refusal: "unauthorized", reason: "revoked API token" };
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, refusal: "unauthorized", reason: "expired API token" };
  }
  if (isUserBanned(row.User)) return { ok: false, refusal: "forbidden", reason: "user banned" };
  if (isTouchDue(row.lastUsedAt, now)) {
    try {
      await prisma.mcpAgentToken.updateMany({
        where: {
          id: row.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: touchThreshold(now) } }],
        },
        data: { lastUsedAt: now },
      });
    } catch {
      // Usage stamping is informational.
    }
  }
  return {
    ok: true,
    identity: {
      userId: row.userId,
      credential: { kind: "agent_token", tokenId: row.id },
      label: row.name,
      allowPropose: row.allowPropose,
      autoApprove: row.allowPropose && row.autoApprove,
    },
  };
}

/** Resolve verified OAuth access-token claims to their live grant. */
export async function resolveOauthClaims(
  claims: Record<string, unknown>,
  { prisma, now }: { prisma: McpCredentialPrisma; now: Date },
): Promise<McpCredentialResult> {
  const sub = claims.sub;
  const clientId = claims.client_id ?? claims.azp;
  const grantId = claims[MCP_GRANT_ID_CLAIM];
  if (typeof sub !== "string" || sub.length === 0) {
    return { ok: false, refusal: "unauthorized", reason: "token subject missing" };
  }
  if (typeof clientId !== "string" || clientId.length === 0) {
    return { ok: false, refusal: "unauthorized", reason: "token client missing" };
  }
  if (typeof grantId !== "string" || grantId.length === 0) {
    return { ok: false, refusal: "unauthorized", reason: "token carries no grant" };
  }
  const grant = await prisma.mcpGrant.findUnique({
    where: { id: grantId },
    select: grantSelect,
  });
  // A revoked, foreign or mismatched grant: re-authorizing (a new grant) can
  // restore access, but a challenge would misrepresent the denial.
  if (!grant || grant.userId !== sub || grant.clientId !== clientId || grant.revokedAt !== null) {
    return { ok: false, refusal: "forbidden", reason: "grant missing, mismatched or revoked" };
  }
  // `grant.userId === sub` was just checked, so this is the token subject.
  if (isUserBanned(grant.User)) return { ok: false, refusal: "forbidden", reason: "user banned" };
  if (isTouchDue(grant.lastUsedAt, now)) {
    try {
      await prisma.mcpGrant.updateMany({
        where: {
          id: grant.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: touchThreshold(now) } }],
        },
        data: { lastUsedAt: now },
      });
    } catch {
      // Usage stamping is informational.
    }
  }
  return {
    ok: true,
    identity: {
      userId: grant.userId,
      credential: { kind: "oauth", grantId: grant.id, clientId: grant.clientId },
      label: grant.clientName ?? "OAuth client",
      allowPropose: grant.allowPropose,
      autoApprove: grant.allowPropose && grant.autoApprove,
    },
  };
}

/** Recheck a held request without retaining or re-reading its presented secret. */
export async function isMcpIdentityLive(
  identity: McpIdentity,
  prisma: McpCredentialPrisma,
): Promise<boolean> {
  const credential = identity.credential;
  if (credential.kind === "agent_token") {
    const row = await prisma.mcpAgentToken.findUnique({
      where: { id: credential.tokenId },
      select: { userId: true, revokedAt: true, expiresAt: true, User: credentialUserSelect },
    });
    return (
      !!row &&
      row.userId === identity.userId &&
      row.revokedAt === null &&
      (row.expiresAt === null || row.expiresAt.getTime() > Date.now()) &&
      !isUserBanned(row.User)
    );
  }
  const row = await prisma.mcpGrant.findUnique({
    where: { id: credential.grantId },
    select: { userId: true, clientId: true, revokedAt: true, User: credentialUserSelect },
  });
  return (
    !!row &&
    row.userId === identity.userId &&
    row.clientId === credential.clientId &&
    row.revokedAt === null &&
    !isUserBanned(row.User)
  );
}
