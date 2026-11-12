/**
 * The two per-connection flags a person sets on the MCP consent page —
 * "Allow this agent to propose packages" (default on) and "Auto-approve its
 * proposals" (default off) — carried from the approval into the `McpGrant`
 * the authorization code exchanges into (docs/mcp.md).
 *
 * Adapted from ws-model-proxy's `mcp-consent-level.ts`, which records a
 * READ/FULL level the same way. The consent page posts
 * `{ accept, allowPropose, autoApprove, oauth_query }` to Better-Auth's
 * `/oauth2/consent`: a cookie-session endpoint behind Better-Auth's origin
 * check, with the transaction pinned by the signed `oauth_query`. The flags
 * are fields of that body only; nothing the client controls (authorize
 * parameters, scope, the signed query) is ever read as a flag. Absent flags
 * mean the defaults, and `autoApprove` is forced off without `allowPropose`
 * (the same rule as `mcpTokens.create`).
 *
 * - before: refuse a non-boolean flag.
 * - after: when the approval issued a code, record the flags on the exact
 *   grant generation the code exchanges into BEFORE the response (and so the
 *   code) reaches the browser. A storage failure withholds the code (500)
 *   and forgets the remembered consent, so the next authorize shows the page
 *   again instead of silently keeping the old flags.
 *
 * Remembered consent (no page shown) writes nothing: re-authorization keeps
 * the flags last chosen. They can be changed later on the connections page
 * (`mcpConnections.update`).
 */
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import prisma from "@cockpit-context/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deriveMcpConsentReferenceId } from "./mcp-grant";

/** Better-Auth's consent endpoint path (router-relative). */
export const MCP_CONSENT_ENDPOINT_PATH = "/oauth2/consent";

export type McpGrantFlags = { allowPropose: boolean; autoApprove: boolean };

/** The three allowed states: query-only, propose, and auto-approve. */
export function normalizeMcpFlags(allowPropose: boolean, autoApprove: boolean): McpGrantFlags {
  return { allowPropose, autoApprove: allowPropose && autoApprove };
}

/** The defaults: the same as the token dialog's. */
export const DEFAULT_MCP_GRANT_FLAGS: McpGrantFlags = { allowPropose: true, autoApprove: false };

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The approval's flags; null when a present flag is not a boolean. */
export function consentFlagsOf(body: unknown): McpGrantFlags | null {
  const record = bodyRecord(body);
  const allowPropose = record.allowPropose ?? DEFAULT_MCP_GRANT_FLAGS.allowPropose;
  const autoApprove = record.autoApprove ?? DEFAULT_MCP_GRANT_FLAGS.autoApprove;
  if (typeof allowPropose !== "boolean" || typeof autoApprove !== "boolean") return null;
  return normalizeMcpFlags(allowPropose, autoApprove);
}

/** Whether the body approves (Better-Auth treats anything but `true` as a denial). */
export function consentAccepts(body: unknown): boolean {
  return bodyRecord(body).accept === true;
}

/**
 * Whether the consent endpoint answered with a redirect carrying an
 * authorization code (and no OAuth error).
 */
export function consentIssuedCode(returned: unknown): boolean {
  const record = bodyRecord(returned);
  if (record.redirect !== true || typeof record.url !== "string") return false;
  try {
    const params = new URL(record.url).searchParams;
    return params.has("code") && !params.has("error");
  } catch {
    return false;
  }
}

async function signedQueryOf(): Promise<string | null> {
  try {
    return (await getOAuthProviderState())?.query ?? null;
  } catch {
    return null;
  }
}

function invalidFlags(): APIError {
  return new APIError("BAD_REQUEST", {
    error: "invalid_request",
    error_description: "allowPropose and autoApprove must be booleans",
  });
}

/**
 * Records the person's flags on the exact grant generation
 * `(userId, clientId, referenceId)`. Creates the grant when absent (code
 * exchange then reuses it), updates an active one, and leaves a tombstone
 * alone (code exchange rejects it): returns null for a tombstone. Throws on a
 * storage failure: the caller then withholds the code.
 */
export async function recordConsentedMcpGrantFlags(input: {
  userId: string;
  clientId: string;
  referenceId: string;
  clientName: string | null;
  flags: McpGrantFlags;
}): Promise<{ grantId: string } | null> {
  const key = {
    userId_clientId_referenceId: {
      userId: input.userId,
      clientId: input.clientId,
      referenceId: input.referenceId,
    },
  };
  return prisma.$transaction(async (tx) => {
    // ON CONFLICT DO NOTHING: a racing create never aborts this transaction.
    const inserted = await tx.mcpGrant.createMany({
      data: [
        {
          userId: input.userId,
          clientId: input.clientId,
          referenceId: input.referenceId,
          clientName: input.clientName,
          ...input.flags,
        },
      ],
      skipDuplicates: true,
    });
    const row = await tx.mcpGrant.findUnique({
      where: key,
      select: { id: true, revokedAt: true },
    });
    if (row === null) throw new Error("MCP grant missing after upsert");
    if (row.revokedAt !== null) return null;
    if (inserted.count === 0) {
      await tx.mcpGrant.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { ...input.flags, ...(input.clientName ? { clientName: input.clientName } : {}) },
      });
    }
    return { grantId: row.id };
  });
}

function errorClass(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

/**
 * The Better-Auth plugin carrying the consent page's flags into the grant.
 * Composed right after `mcp()`, so the provider's own before hook has
 * verified the signed query first.
 */
export function mcpConsentFlags({ secret }: { secret: string }) {
  return {
    id: "cockpit-context-mcp-consent-flags",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === MCP_CONSENT_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!consentAccepts(ctx.body)) return;
            if (consentFlagsOf(ctx.body) === null) throw invalidFlags();
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === MCP_CONSENT_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!consentAccepts(ctx.body) || !consentIssuedCode(ctx.context.returned)) return;
            const flags = consentFlagsOf(ctx.body);
            if (flags === null) throw invalidFlags();
            const session = await getSessionFromCtx(ctx);
            const query = await signedQueryOf();
            const clientId = query === null ? null : new URLSearchParams(query).get("client_id");
            if (!session || !clientId) {
              // The endpoint itself required both; refusing keeps the code from the browser.
              throw new APIError("BAD_REQUEST", { error: "invalid_request" });
            }
            const referenceId = deriveMcpConsentReferenceId({
              secret,
              sessionId: session.session.id,
              clientId,
            });
            try {
              const client = await prisma.oauthClient.findUnique({
                where: { clientId },
                select: { name: true },
              });
              await recordConsentedMcpGrantFlags({
                userId: session.user.id,
                clientId,
                referenceId,
                clientName: client?.name ?? null,
                flags,
              });
            } catch (error) {
              console.error("[mcp-consent] recording the grant flags failed", errorClass(error));
              try {
                await ctx.context.adapter.deleteMany({
                  model: "oauthConsent",
                  where: [
                    { field: "clientId", value: clientId },
                    { field: "userId", value: session.user.id },
                    { field: "referenceId", value: referenceId },
                  ],
                });
              } catch (forgetError) {
                console.error(
                  "[mcp-consent] forgetting the remembered consent failed",
                  errorClass(forgetError),
                );
              }
              throw new APIError("INTERNAL_SERVER_ERROR", { error: "server_error" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
