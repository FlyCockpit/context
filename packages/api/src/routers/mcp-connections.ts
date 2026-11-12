import { normalizeMcpFlags } from "@cockpit-context/auth/mcp-consent-flags";
import prisma, { type Prisma } from "@cockpit-context/db";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId } from "../lib/schemas";

/**
 * OAuth MCP connections (docs/mcp.md): Cockpit Context's per-connection
 * settings row (`McpGrant`) for each OAuth client the user approved on the
 * consent page. Revoking a grant also ends the client's tokens and consent
 * in the Better-Auth OAuth provider tables.
 *
 * The consent `referenceId` is server-internal and never returned.
 */

const grantSelect = {
  id: true,
  createdAt: true,
  clientId: true,
  clientName: true,
  allowPropose: true,
  autoApprove: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.McpGrantSelect;

type GrantRow = Prisma.McpGrantGetPayload<{ select: typeof grantSelect }>;

/**
 * Which OAuth MCP access a revocation ends: one generation (the user, client
 * and consent reference a grant belongs to), or, with `userId` alone, every
 * generation the user holds.
 */
type OauthRevocationScope = { userId: string; clientId?: string; referenceId?: string };

/**
 * The writes that end OAuth MCP access for `scope`, to run in one
 * `$transaction`: the matching grants become tombstones (`/mcp` refuses them
 * at once, even for an access JWT that has not expired yet, and token
 * issuance refuses them), and the stored access tokens, refresh tokens and
 * remembered consent are deleted, so reconnecting means a new sign-in and a
 * new consent. Shared by `revoke` (one generation) and `users.archive` (all of
 * a user's).
 */
export function oauthRevocationWrites(scope: OauthRevocationScope, now = new Date()) {
  return [
    prisma.mcpGrant.updateMany({
      where: { ...scope, revokedAt: null },
      data: { revokedAt: now },
    }),
    // Access tokens first: they reference refresh tokens.
    prisma.oauthAccessToken.deleteMany({ where: scope }),
    prisma.oauthRefreshToken.deleteMany({ where: scope }),
    prisma.oauthConsent.deleteMany({ where: scope }),
  ];
}

function serializeGrant(row: GrantRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    clientId: row.clientId,
    /** Client-supplied at registration: render as plain text. */
    clientName: row.clientName,
    allowPropose: row.allowPropose,
    autoApprove: row.autoApprove,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    state: row.revokedAt ? ("revoked" as const) : ("active" as const),
  };
}

export const mcpConnectionsRouter = {
  list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.mcpGrant.findMany({
      where: withCursor({ userId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      select: grantSelect,
    });
    const page = cursorPage(rows, input.limit, "createdAt");
    return { items: page.items.map(serializeGrant), nextCursor: page.nextCursor };
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: entityId,
        allowPropose: z.boolean().optional(),
        autoApprove: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const current = await findOwnedOrThrow({
        find: (args) => prisma.mcpGrant.findFirst(args),
        args: { where: { id: input.id }, select: grantSelect },
        owner: { field: "userId", id: userId },
        notFound: "Connection not found.",
      });
      if (current.revokedAt) {
        throw reasonError("CONFLICT", "CONNECTION_REVOKED", "That connection was revoked.");
      }
      const { allowPropose, autoApprove } = normalizeMcpFlags(
        input.allowPropose ?? current.allowPropose,
        input.autoApprove ?? current.autoApprove,
      );
      const { count } = await prisma.mcpGrant.updateMany({
        where: {
          id: current.id,
          userId,
          revokedAt: null,
          allowPropose: current.allowPropose,
          autoApprove: current.autoApprove,
        },
        data: { allowPropose, autoApprove },
      });
      if (count === 0) {
        throw reasonError(
          "CONFLICT",
          "CONNECTION_CHANGED",
          "That connection changed or was revoked. Reload and try again.",
        );
      }
      return serializeGrant({ ...current, allowPropose, autoApprove });
    }),

  /**
   * Revoke a connection. Idempotent. Ends this grant's generation through
   * `oauthRevocationWrites`: the grant becomes a tombstone and the client's
   * tokens and remembered consent for it are deleted.
   */
  revoke: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const grant = await findOwnedOrThrow({
        find: (args) => prisma.mcpGrant.findFirst(args),
        args: {
          where: { id: input.id },
          select: { id: true, clientId: true, referenceId: true },
        },
        owner: { field: "userId", id: userId },
        notFound: "Connection not found.",
      });
      // `(userId, clientId, referenceId)` is unique on McpGrant, so the
      // generation names exactly this grant.
      await prisma.$transaction(
        oauthRevocationWrites({ userId, clientId: grant.clientId, referenceId: grant.referenceId }),
      );
      return { ok: true as const };
    }),
};
