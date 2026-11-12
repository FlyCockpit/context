import { canonicalMcpResource } from "@cockpit-context/auth/mcp-config";
import prisma from "@cockpit-context/db";
import { env } from "@cockpit-context/env/server";

import { protectedProcedure } from "../index";
import { ongoingWhere } from "../lib/conversation-activity";

/**
 * The signed-in shell's one cheap read:
 * the Packages nav badge (pending proposals), the Ongoing page's first-run
 * "Getting started" card, and its live-run count. Every count is scoped to
 * the caller; nothing of another user's rows is read.
 */
export const homeRouter = {
  status: protectedProcedure.handler(async ({ context }) => {
    const ownerId = context.session.user.id;
    const now = new Date();
    const [packageRow, tokenRow, grantRow, conversationRow, pendingProposals, ongoing] =
      await Promise.all([
        prisma.package.findFirst({ where: { ownerId }, select: { id: true } }),
        prisma.mcpAgentToken.findFirst({
          where: {
            userId: ownerId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        }),
        prisma.mcpGrant.findFirst({
          where: { userId: ownerId, revokedAt: null },
          select: { id: true },
        }),
        prisma.conversation.findFirst({ where: { ownerId }, select: { id: true } }),
        prisma.packageProposal.count({ where: { ownerId, status: "PENDING" } }),
        prisma.conversation.count({ where: { AND: [{ ownerId }, ongoingWhere] } }),
      ]);
    return {
      modelConfigured: Boolean(env.OPENROUTER_API_KEY && env.COCKPIT_CONTEXT_MODEL),
      hasPackages: packageRow !== null,
      hasConnection: tokenRow !== null || grantRow !== null,
      hasConversations: conversationRow !== null,
      pendingProposals,
      ongoingConversations: ongoing,
      /** The `/mcp` resource the OAuth provider and token resolver serve. */
      mcpUrl: canonicalMcpResource(env.BETTER_AUTH_URL),
    };
  }),
};
