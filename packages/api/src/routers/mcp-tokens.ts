import { normalizeMcpFlags as flags } from "@cockpit-context/auth/mcp-consent-flags";
import prisma, { type Prisma } from "@cockpit-context/db";
import { mintMcpAgentToken } from "@cockpit-context/db/mcp-agent-token";
import { env } from "@cockpit-context/env/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { cockpitContextRateBudget } from "../lib/rate-budgets";
import { entityId, shortText } from "../lib/schemas";

/**
 * MCP API tokens (docs/mcp.md). ⚠️ Dangerous row: the plaintext
 * `cockpit_context_…` token is returned exactly once, by `create`, and is never stored.
 * The row keeps only the lookup prefix and an HMAC-SHA256 digest under a
 * purpose key derived from BETTER_AUTH_SECRET (`@cockpit-context/db/mcp-agent-token`,
 * the ws-model-proxy scheme). No projection here selects `secretDigest`.
 *
 * These are human-only procedures on the cookie surface: an MCP credential
 * never reaches oRPC (docs/access-matrix.md), so an agent cannot mint
 * or widen a token.
 */

/** Active (unrevoked, unexpired) tokens one user may hold. */
const MCP_TOKEN_MAX_ACTIVE_PER_USER = 50;
/** A token may expire at most this far ahead (or never). */
const MAX_TTL_MS = 365 * 86_400_000;

/** Attempts at the Serializable create before giving up with CONFLICT. */
const CREATE_ATTEMPTS = 3;

/** Postgres refused a Serializable transaction (a concurrent one won); safe to retry. */
function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034"
  );
}

/**
 * One point per token minted. The default 20 per hour
 * (`COCKPIT_CONTEXT_MCP_TOKEN_CREATIONS_PER_HOUR`) is generous for configuring
 * agents by hand; fail-closed because each point is a standing credential.
 */
const consumeCreateBudget = createProcedureBudget({
  keyPrefix: "rl:mcp-tokens-create",
  budget: () => cockpitContextRateBudget("mcpTokenCreate"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many tokens created. Try again in ${seconds}s.`,
  unavailableMessage: "Creating tokens is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[mcp-tokens] create budget unavailable, failing closed:",
});

const mcpTokenSelect = {
  id: true,
  createdAt: true,
  name: true,
  lookupPrefix: true,
  allowPropose: true,
  autoApprove: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
} satisfies Prisma.McpAgentTokenSelect;

type McpTokenRow = Prisma.McpAgentTokenGetPayload<{ select: typeof mcpTokenSelect }>;

function tokenState(row: McpTokenRow, now: Date): "active" | "revoked" | "expired" {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

function serializeToken(row: McpTokenRow, now = new Date()) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    name: row.name,
    /** Non-secret prefix, so the user can tell tokens apart. */
    lookupPrefix: row.lookupPrefix,
    allowPropose: row.allowPropose,
    autoApprove: row.autoApprove,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    state: tokenState(row, now),
  };
}

function activeWhere(userId: string, now: Date): Prisma.McpAgentTokenWhereInput {
  return { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export const mcpTokensRouter = {
  list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.mcpAgentToken.findMany({
      where: withCursor({ userId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      select: mcpTokenSelect,
    });
    const page = cursorPage(rows, input.limit, "createdAt");
    const now = new Date();
    return {
      items: page.items.map((row) => serializeToken(row, now)),
      nextCursor: page.nextCursor,
    };
  }),

  /** Mint a token. The response's `secret` is the only time the plaintext exists outside the caller. */
  create: protectedProcedure
    .input(
      z.object({
        name: shortText,
        /** Omit or null for a token that never expires. */
        expiresAt: z.coerce.date().nullish(),
        allowPropose: z.boolean().default(true),
        autoApprove: z.boolean().default(false),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const now = new Date();
      const expiresAt = input.expiresAt ?? null;
      if (expiresAt) {
        if (expiresAt.getTime() <= now.getTime()) {
          throw reasonError("BAD_REQUEST", "EXPIRY_IN_PAST", "Expiry must be in the future.");
        }
        if (expiresAt.getTime() - now.getTime() > MAX_TTL_MS) {
          throw reasonError("BAD_REQUEST", "EXPIRY_TOO_FAR", "Expiry must be within a year.");
        }
      }
      await consumeCreateBudget(`user:${userId}`);
      const minted = mintMcpAgentToken(env.BETTER_AUTH_SECRET);
      const insert = () =>
        prisma.$transaction(
          async (tx) => {
            const active = await tx.mcpAgentToken.count({ where: activeWhere(userId, now) });
            if (active >= MCP_TOKEN_MAX_ACTIVE_PER_USER) {
              throw reasonError(
                "CONFLICT",
                "TOKEN_LIMIT",
                "Active token limit reached. Revoke a token before creating another.",
              );
            }
            return tx.mcpAgentToken.create({
              data: {
                userId,
                name: input.name,
                lookupPrefix: minted.lookupPrefix,
                secretDigest: minted.secretDigest,
                expiresAt,
                ...flags(input.allowPropose, input.autoApprove),
              },
              select: mcpTokenSelect,
            });
          },
          { isolationLevel: "Serializable" },
        );
      // Two creates by the same user at once: Postgres aborts one with a
      // serialization failure (P2034). Nothing was written, so run it again
      // (it re-counts, so the limit holds); after a few losses say CONFLICT
      // rather than a 500.
      let row: Awaited<ReturnType<typeof insert>> | undefined;
      for (let attempt = 1; row === undefined; attempt += 1) {
        try {
          row = await insert();
        } catch (error) {
          if (!isSerializationFailure(error)) throw error;
          if (attempt >= CREATE_ATTEMPTS) {
            throw reasonError(
              "CONFLICT",
              "CREATE_CONFLICT",
              "Another token was being created at the same time. Try again.",
            );
          }
        }
      }
      return { token: serializeToken(row, now), secret: minted.token };
    }),

  /** Change a live token's name or flags. A revoked token cannot be edited. */
  update: protectedProcedure
    .input(
      z.object({
        id: entityId,
        name: shortText.optional(),
        allowPropose: z.boolean().optional(),
        autoApprove: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const current = await findOwnedOrThrow({
        find: (args) => prisma.mcpAgentToken.findFirst(args),
        args: { where: { id: input.id }, select: mcpTokenSelect },
        owner: { field: "userId", id: userId },
        notFound: "Token not found.",
      });
      if (current.revokedAt) {
        throw reasonError("CONFLICT", "TOKEN_REVOKED", "That token was revoked.");
      }
      const changesFlags = input.allowPropose !== undefined || input.autoApprove !== undefined;
      const { count } = await prisma.mcpAgentToken.updateMany({
        where: {
          id: current.id,
          userId,
          revokedAt: null,
          ...(changesFlags
            ? { allowPropose: current.allowPropose, autoApprove: current.autoApprove }
            : {}),
        },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(changesFlags
            ? flags(
                input.allowPropose ?? current.allowPropose,
                input.autoApprove ?? current.autoApprove,
              )
            : {}),
        },
      });
      if (count === 0)
        throw reasonError(
          "CONFLICT",
          "TOKEN_CHANGED",
          "That token changed or was revoked. Reload and try again.",
        );
      const row = await findOwnedOrThrow({
        find: (args) => prisma.mcpAgentToken.findFirst(args),
        args: { where: { id: current.id }, select: mcpTokenSelect },
        owner: { field: "userId", id: userId },
        notFound: "Token not found.",
      });
      return serializeToken(row);
    }),

  /** Revoke a token. Idempotent; the `/mcp` resolver refuses revoked tokens. */
  revoke: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const token = await findOwnedOrThrow({
        find: (args) => prisma.mcpAgentToken.findFirst(args),
        args: { where: { id: input.id }, select: { id: true } },
        owner: { field: "userId", id: userId },
        notFound: "Token not found.",
      });
      await prisma.mcpAgentToken.updateMany({
        where: { id: token.id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true as const };
    }),
};
