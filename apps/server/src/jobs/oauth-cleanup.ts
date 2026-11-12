import { sweepExpiredOAuthArtifacts } from "@cockpit-context/api/lib/oauth-retention";
import { defineJob, HOUR, handleJob, MINUTE } from "@cockpit-context/jobs";
import { z } from "zod";

/**
 * Hourly retention sweep of the Better-Auth OAuth provider's rows behind MCP
 * OAuth: expired access and refresh tokens and client assertions (after a
 * 24 h audit grace) and abandoned dynamic client registrations
 * (`packages/api/src/lib/oauth-retention.ts`, ported from ws-model-proxy's
 * `oauth-cleanup.ts`).
 *
 * Single attempt: every delete is idempotent and state-predicated, and the
 * next hourly slot is the retry.
 */
export const oauthCleanupJob = defineJob(
  "oauth.cleanup",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

/** Hourly at :23, off the other schedules' marks. */
export const OAUTH_CLEANUP_SCHEDULE = { everyMs: HOUR, offsetMs: 23 * MINUTE };

export const oauthCleanupHandler = handleJob(oauthCleanupJob, async ({ id, payload }) => {
  const start = Date.now();
  const counts = await sweepExpiredOAuthArtifacts();
  console.log(
    `[oauth.cleanup] Job ${id} (${payload.reason}) deleted ` +
      `${counts.accessTokens} access token(s), ${counts.refreshTokens} refresh token(s), ` +
      `${counts.clientAssertions} client assertion(s), ${counts.unclaimedClients} abandoned client(s) ` +
      `in ${Date.now() - start}ms`,
  );
});
