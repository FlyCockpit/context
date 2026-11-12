import { sweepExpiredConversations } from "@cockpit-context/api/lib/conversation-retention";
import { env } from "@cockpit-context/env/server";
import { DAY, defineJob, HOUR, handleJob, MINUTE } from "@cockpit-context/jobs";
import { z } from "zod";

/**
 * Automatic conversation retention: delete conversations whose last activity
 * is older than `COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS`, with their runs, turns and
 * leases (`packages/api/src/lib/conversation-retention.ts`). Conversations with
 * a queued or running run are skipped. Not scheduled when the setting is 0, and
 * a no-op if a row is claimed anyway.
 *
 * Logs counts only, never a title, question or owner.
 *
 * Single attempt: the delete is idempotent and state-predicated, and the next
 * daily slot is the retry (it also finishes a backlog past the batch cap).
 */
export const conversationRetentionJob = defineJob(
  "conversations.retention",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

/** Daily at 04:37 UTC, after the auth sweep and off the round hours. */
export const CONVERSATION_RETENTION_SCHEDULE = { everyMs: DAY, offsetMs: 4 * HOUR + 37 * MINUTE };

/** Whether automatic deletion is on (0 keeps conversations until deleted). */
export function conversationRetentionEnabled(): boolean {
  return env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS > 0;
}

export const conversationRetentionHandler = handleJob(
  conversationRetentionJob,
  async ({ id, payload }) => {
    const days = env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS;
    const start = Date.now();
    const result = await sweepExpiredConversations(days);
    if (!result.enabled) {
      console.log(
        `[conversations.retention] Job ${id} (${payload.reason}) skipped: retention is off.`,
      );
      return;
    }
    console.log(
      `[conversations.retention] Job ${id} (${payload.reason}) deleted ` +
        `${result.deleted} conversation(s) inactive for ${days}+ day(s) ` +
        `in ${result.batches} batch(es), ${Date.now() - start}ms` +
        (result.capped ? "; batch cap reached, the next run continues" : ""),
    );
  },
);
