import { backupFreshnessEnabled } from "@cockpit-context/api/lib/backup-freshness";
import { env } from "@cockpit-context/env/server";
import {
  createJobRunner,
  DAY,
  HOUR,
  type JobRunnerHealth,
  MINUTE,
  pruneJobsHandler,
  pruneJobsJob,
  type RegisteredJob,
  startPeriodicJob,
} from "@cockpit-context/jobs";
import { recoverInterruptedGitWork, sweepTmpDir } from "@cockpit-context/repos";
import { pruneStorageJob } from "@cockpit-context/repos/jobs";
import { getRunEngine, onSummaryFailure } from "@cockpit-context/runs";
import { summarizeCheckoutJob } from "@cockpit-context/runs/jobs";
import {
  CHECK_BACKUP_FRESHNESS_SCHEDULE,
  checkBackupFreshnessHandler,
  checkBackupFreshnessJob,
} from "./check-backup-freshness.js";
import {
  CONVERSATION_RETENTION_SCHEDULE,
  conversationRetentionEnabled,
  conversationRetentionHandler,
  conversationRetentionJob,
} from "./conversation-retention.js";
import {
  NOTIFY_DATA_DELETIONS_SCHEDULE,
  notifyDataDeletionsHandler,
  notifyDataDeletionsJob,
} from "./notify-data-deletions.js";
import { OAUTH_CLEANUP_SCHEDULE, oauthCleanupHandler, oauthCleanupJob } from "./oauth-cleanup.js";
import { sendJobFailureAlert, sendSummaryRunFailureAlert } from "./operational-alerts.js";
import {
  REAP_EXPIRED_AUTH_TOKENS_SCHEDULE,
  reapExpiredAuthTokensHandler,
  reapExpiredAuthTokensJob,
} from "./reap-expired-auth-tokens.js";
import { fetchRepositoryHandler, pruneStorageHandler } from "./repository-jobs.js";
import { summarizeCheckoutHandler } from "./run-jobs.js";

/**
 * Every job type this server runs. Adding a job: define it with `defineJob`,
 * bind its handler with `handleJob`, list it here (docs/development.md). A row
 * whose type is not listed is never claimed — it stays `queued` until a build
 * that knows it boots.
 */
export const SERVER_JOBS: readonly RegisteredJob[] = [
  pruneJobsHandler,
  reapExpiredAuthTokensHandler,
  checkBackupFreshnessHandler,
  fetchRepositoryHandler,
  pruneStorageHandler,
  summarizeCheckoutHandler,
  oauthCleanupHandler,
  conversationRetentionHandler,
  notifyDataDeletionsHandler,
];

/** Longest a shutdown waits for interrupted agent runs to save their state. */
const RUN_SHUTDOWN_MS = 5_000;

export type BackgroundJobs = {
  health(): JobRunnerHealth;
  /** Stop schedules, stop claiming, drain. `true` when every job finished in time. */
  stop(): Promise<boolean>;
};

/**
 * Start the in-process job runner and the recurring schedules. Called by the
 * server lifecycle (../lifecycle.ts) after Postgres answers and before the HTTP
 * listener opens; stopped first on shutdown.
 */
export async function startBackgroundJobs(): Promise<BackgroundJobs> {
  // Leftover per-invocation SSH material from a crashed process (decrypted
  // keys) is removed before any git job can run. Single process: nothing in
  // COCKPIT_CONTEXT_DATA_DIR/tmp is live at boot.
  await sweepTmpDir().catch((error: unknown) => {
    console.warn("[jobs] could not sweep the git temp directory", error);
  });
  // Runs that were queued or running when the last process died are
  // interrupted and their checkout leases released, before anything new starts.
  const runs = getRunEngine();
  const interrupted = await runs.recover();
  if (interrupted > 0) console.log(`[runs] Marked ${interrupted} orphaned run(s) interrupted.`);
  // Clones and worktree adds the crash cut short: CLONING repositories and
  // PENDING checkouts become FAILED (retried on next use) and their partial
  // directories go. After run recovery, so the dead runs' leases are released.
  await recoverInterruptedGitWork()
    .then((recovered) => {
      const total = recovered.repositories + recovered.stagingDirs + recovered.checkouts;
      if (total > 0) {
        console.log(
          `[repos] Recovered interrupted git work: ${recovered.repositories} clone(s), ` +
            `${recovered.stagingDirs} staging dir(s), ${recovered.checkouts} checkout(s).`,
        );
      }
    })
    .catch((error: unknown) => {
      console.warn("[jobs] could not recover interrupted clones and checkouts", error);
    });
  // A `checkout.summarize` job succeeds once its run has started, so a summary
  // run that later fails raises its own alert, naming the run and checkout,
  // under the job type's cooldown. Interrupted summaries (shutdown) raise nothing.
  const stopSummaryAlerts = onSummaryFailure((failure) =>
    sendSummaryRunFailureAlert({
      jobType: summarizeCheckoutJob.type,
      runId: failure.runId,
      checkoutId: failure.checkoutId,
      error: failure.error,
    }),
  );
  const runner = createJobRunner({
    jobs: SERVER_JOBS,
    concurrency: env.JOBS_CONCURRENCY,
    onTerminalFailure: sendJobFailureAlert,
  });
  await runner.start();

  const stops = [
    startPeriodicJob({
      definition: notifyDataDeletionsJob,
      payload: { reason: "schedule" },
      ...NOTIFY_DATA_DELETIONS_SCHEDULE,
    }),
    // Daily at 05:43 UTC, after the auth sweep, off the round hours.
    startPeriodicJob({
      definition: pruneJobsJob,
      payload: {},
      everyMs: DAY,
      offsetMs: 5 * HOUR + 43 * MINUTE,
    }),
    // Hourly at :11: re-measure clones and checkouts, then evict over the cap.
    startPeriodicJob({
      definition: pruneStorageJob,
      payload: { reason: "schedule", measure: true },
      everyMs: HOUR,
      offsetMs: 11 * MINUTE,
    }),
    startPeriodicJob({
      definition: reapExpiredAuthTokensJob,
      payload: { reason: "schedule" },
      ...REAP_EXPIRED_AUTH_TOKENS_SCHEDULE,
    }),
    // Hourly at :23: expired MCP OAuth tokens and abandoned registrations.
    startPeriodicJob({
      definition: oauthCleanupJob,
      payload: { reason: "schedule" },
      ...OAUTH_CLEANUP_SCHEDULE,
    }),
  ];
  // Conversation retention: with COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS=0
  // conversations are kept until deleted, so nothing is scheduled.
  if (conversationRetentionEnabled()) {
    stops.push(
      startPeriodicJob({
        definition: conversationRetentionJob,
        payload: { reason: "schedule" },
        ...CONVERSATION_RETENTION_SCHEDULE,
      }),
    );
  }
  // Backup freshness is gated on the BACKUP_* config: with backups off there
  // is nothing to measure, so nothing is scheduled (and the admin card says so).
  if (backupFreshnessEnabled()) {
    stops.push(
      startPeriodicJob({
        definition: checkBackupFreshnessJob,
        payload: { reason: "schedule" },
        ...CHECK_BACKUP_FRESHNESS_SCHEDULE,
      }),
    );
  }

  return {
    health: () => runner.health(),
    async stop() {
      for (const stop of stops) stop();
      // Interrupt live agent runs (summary runs included: they outlive the job
      // that started them) and let them save their state before the drain.
      const runsSettled = await runs.shutdown(RUN_SHUTDOWN_MS);
      if (!runsSettled) console.error("[runs] Agent runs did not settle before shutdown.");
      stopSummaryAlerts();
      return runner.stop();
    },
  };
}
