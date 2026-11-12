import prisma, { type Prisma } from "@cockpit-context/db";

import { ACTIVE_RUN_STATUSES } from "./conversation-activity";

/**
 * Automatic conversation retention (docs/product.md). A conversation whose last activity is
 * older than `COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS` is deleted with everything
 * hanging off it: `agent_run` (main and helper runs) cascades from
 * `conversation`, and `run_turn` (messages, steering, tool calls and results)
 * and `checkout_lease` cascade from `agent_run`. Packages, proposals,
 * checkouts and repositories are never touched: their relations to a
 * conversation are the conversation's own foreign keys.
 *
 * Global: ownership plays no part. Every predicate is re-applied on the
 * delete itself, so a conversation that came back to life between the read
 * and the delete (a follow-up message, a new run) is kept.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Conversations per delete statement. Each one cascades to all of its turns. */
export const CONVERSATION_RETENTION_BATCH = 100;
/**
 * Batches per sweep. A backlog larger than this (a first run after the
 * retention period was shortened) is finished by the next scheduled sweeps.
 */
export const CONVERSATION_RETENTION_MAX_BATCHES = 50;

export interface ConversationRetentionResult {
  /** False when retention is 0 (keep until deleted): nothing was read. */
  enabled: boolean;
  deleted: number;
  batches: number;
  /** A full last batch at the batch cap: more may be eligible. */
  capped: boolean;
}

/** The moment before which a conversation's last activity makes it eligible. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Eligible conversations: every activity timestamp is strictly before the
 * cutoff, and no run is queued or running. "Last activity" is the latest of
 * the conversation's `lastActivityAt` and `updatedAt`, each run's creation,
 * update and end, and each saved turn, so a conversation is kept while any of
 * them falls on or after the cutoff.
 */
export function retentionWhere(cutoff: Date): Prisma.ConversationWhereInput {
  return {
    lastActivityAt: { lt: cutoff },
    updatedAt: { lt: cutoff },
    AgentRuns: {
      none: {
        OR: [
          { status: { in: ACTIVE_RUN_STATUSES } },
          { createdAt: { gte: cutoff } },
          { updatedAt: { gte: cutoff } },
          { finishedAt: { gte: cutoff } },
          { Turns: { some: { createdAt: { gte: cutoff } } } },
        ],
      },
    },
  };
}

/**
 * Delete expired conversations in bounded batches: read an id page under the
 * predicate, delete exactly those ids re-predicated, repeat until a short page,
 * a batch that deleted nothing, or the batch cap.
 */
export async function sweepExpiredConversations(
  days: number,
  now: Date = new Date(),
): Promise<ConversationRetentionResult> {
  if (days <= 0) return { enabled: false, deleted: 0, batches: 0, capped: false };
  const where = retentionWhere(retentionCutoff(days, now));
  let deleted = 0;
  let batches = 0;
  let capped = false;
  while (batches < CONVERSATION_RETENTION_MAX_BATCHES) {
    const rows = await prisma.conversation.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: CONVERSATION_RETENTION_BATCH,
    });
    if (rows.length === 0) break;
    batches += 1;
    const { count } = await prisma.conversation.deleteMany({
      where: { AND: [where, { id: { in: rows.map((row) => row.id) } }] },
    });
    deleted += count;
    if (rows.length < CONVERSATION_RETENTION_BATCH || count === 0) break;
    if (batches === CONVERSATION_RETENTION_MAX_BATCHES) capped = true;
  }
  return { enabled: true, deleted, batches, capped };
}
