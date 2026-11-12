import { reapExpiredAuthTokens } from "@cockpit-context/api/lib/auth-token-retention";
import { DAY, defineJob, HOUR, handleJob, MINUTE } from "@cockpit-context/jobs";
import { z } from "zod";

/**
 * Delete short-lived credential rows past their `expiresAt` — Session and
 * Verification (`packages/api/src/lib/auth-token-retention.ts`).
 *
 * Nothing else prunes those tables: expiry is only enforced by rejecting the
 * credential at read time, so expired rows would accumulate forever. A bounded
 * Postgres delete, scheduled unconditionally.
 *
 * Single attempt: the delete is idempotent and the next daily slot is the retry.
 */
export const reapExpiredAuthTokensJob = defineJob(
  "auth.reap-expired-tokens",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

/**
 * Daily at 04:17 UTC — deliberately off the round-hour marks other daily work
 * (backups at 03:00) fires on. Daily is the right cadence for rows whose only
 * cost is existing.
 */
export const REAP_EXPIRED_AUTH_TOKENS_SCHEDULE = { everyMs: DAY, offsetMs: 4 * HOUR + 17 * MINUTE };

export const reapExpiredAuthTokensHandler = handleJob(
  reapExpiredAuthTokensJob,
  async ({ id, payload }) => {
    const start = Date.now();
    const { deleted } = await reapExpiredAuthTokens();
    console.log(
      `[auth.reap-expired-tokens] Job ${id} (${payload.reason}) deleted ` +
        `${deleted.sessions} session(s), ${deleted.verifications} verification(s) ` +
        `in ${Date.now() - start}ms`,
    );
  },
);
