import {
  type BackupFreshness,
  backupFreshnessNeedsAttention,
  checkBackupFreshness,
  writeBackupFreshness,
} from "@cockpit-context/api/lib/backup-freshness";
import { appSettingFreshnessStore } from "@cockpit-context/api/lib/backup-freshness-store";
import { env } from "@cockpit-context/env/shared";
import { defineJob, HOUR, handleJob, MINUTE } from "@cockpit-context/jobs";
import { escapeHtml } from "@cockpit-context/mailer";
import { z } from "zod";
import { sendOperationalAlert } from "./operational-alerts.js";

/**
 * A stale-backup alert repeats once a day while the condition persists — often
 * enough that it cannot be missed, rare enough that admins do not filter it.
 */
const STALE_ALERT_COOLDOWN_SECONDS = 24 * 60 * 60;

/**
 * Is the newest dump in the backup bucket recent enough?
 *
 * The failure mode that loses data is the backup writer that quietly stopped
 * running, and that produces no error at all. So this job measures the outcome
 * (age of the newest object under BACKUP_S3_PREFIX) rather than watching the
 * process. The verdict is stored in Postgres for the admin dashboard
 * (`adminBackups.status`) and, when it needs attention, emailed to admins with
 * operational alerts enabled.
 *
 * Scheduled only when BACKUP_ENABLED=true (./index.ts), independently of
 * BACKUP_SCHEDULE: manual/external writers are monitored when the daily service is off.
 * Single attempt: a listing error is itself a verdict the handler records and alerts on, and the
 * next slot (6 hours later) is the retry.
 */
export const checkBackupFreshnessJob = defineJob(
  "backup.check-freshness",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

/**
 * Every 6 hours at :20. Nightly dumps land at 03:00 and BACKUP_MAX_AGE_HOURS
 * defaults to 36, so a missed run is noticed within a quarter-day of crossing
 * the threshold.
 */
export const CHECK_BACKUP_FRESHNESS_SCHEDULE = { everyMs: 6 * HOUR, offsetMs: 20 * MINUTE };

export async function runBackupFreshnessCheck(jobId: string): Promise<BackupFreshness | null> {
  if (!env.BACKUP_ENABLED) {
    console.log(
      `[backup.check-freshness] Job ${jobId} skipped — logical backups are disabled (BACKUP_ENABLED=false).`,
    );
    return null;
  }
  const status = await checkBackupFreshness();
  await writeBackupFreshness(appSettingFreshnessStore, status);
  console.log(`[backup.check-freshness] Job ${jobId} → ${describe(status)}`);
  if (backupFreshnessNeedsAttention(status)) {
    await sendOperationalAlert({
      source: "backup.check-freshness",
      message: status.state,
      cooldownSeconds: STALE_ALERT_COOLDOWN_SECONDS,
      subject: "[backups] database backups need attention",
      html: `
    <p>${escapeHtml(describe(status))}</p>
    <dl>
      <dt>Bucket</dt><dd>${escapeHtml(env.BACKUP_S3_BUCKET ?? "")}</dd>
      <dt>Prefix</dt><dd>${escapeHtml(env.BACKUP_S3_PREFIX)}</dd>
      <dt>Threshold</dt><dd>${status.maxAgeHours} hours</dd>
      <dt>Checked</dt><dd>${escapeHtml(status.checkedAt)}</dd>
    </dl>
    <p>Check the backup service's logs, then run one backup by hand and confirm it
    uploads successfully.</p>
  `,
    });
  }
  return status;
}

export const checkBackupFreshnessHandler = handleJob(checkBackupFreshnessJob, async ({ id }) => {
  await runBackupFreshnessCheck(id);
});

function describe(status: BackupFreshness): string {
  switch (status.state) {
    case "fresh":
      return `newest backup ${status.latestKey} is ${status.ageHours}h old (limit ${status.maxAgeHours}h).`;
    case "stale":
      return `newest backup ${status.latestKey} is ${status.ageHours}h old — older than the ${status.maxAgeHours}h limit. The backup writer is not producing dumps.`;
    case "empty":
      return "no backups found in the bucket. The backup writer has never produced a dump.";
    case "misconfigured":
      return `backup monitoring cannot run: ${status.reason}`;
    case "setup-missing":
      return `off-site backup monitoring needs setup: ${status.reason}`;
    case "error":
      return `could not list the backup bucket: ${status.message}`;
  }
}
