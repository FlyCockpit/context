import { adminOr404Procedure } from "../index";
import {
  backupFreshnessEnabled,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  setupMissingBackupFreshness,
} from "../lib/backup-freshness";
import { appSettingFreshnessStore } from "../lib/backup-freshness-store";

export const adminBackupsRouter = {
  /**
   * Last backup-freshness verdict for the admin dashboard. `configured: false`
   * means logical backup monitoring is off and there is nothing
   * to show. A bucket that is set but unusable is NOT that case: it reports
   * `configured: true` with a `misconfigured` verdict, because a backup that
   * can never run has to be louder than one that is merely late, not quieter.
   * `status: null` with `configured: true` means the `backup.check-freshness`
   * job has not recorded a verdict within its TTL — treat as unknown, not
   * healthy. BACKUP_SCHEDULE controls only the separate daily writer; turning
   * it off does not disable monitoring of manual or externally scheduled dumps.
   */
  status: adminOr404Procedure.handler(async () => {
    if (!backupFreshnessEnabled()) return { configured: false as const, status: null };
    const setupMissing = setupMissingBackupFreshness();
    if (setupMissing) return { configured: true as const, status: setupMissing };
    const misconfigured = misconfiguredBackupFreshness();
    if (misconfigured) return { configured: true as const, status: misconfigured };
    return {
      configured: true as const,
      status: await readBackupFreshness(appSettingFreshnessStore),
    };
  }),
};
