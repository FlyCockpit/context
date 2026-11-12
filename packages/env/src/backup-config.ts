/**
 * Import-pure backup capability validation. These functions deliberately do
 * not read process.env so a caller can validate its exact profile without
 * booting the shared environment surface.
 */
export type BackupConfig = {
  /** Monitoring intent; independent from the optional daily writer. */
  BACKUP_ENABLED?: boolean | undefined;
  /** Writer-only schedule settings; the app's monitor does not need them. */
  BACKUP_SCHEDULE?: "off" | "daily" | undefined;
  BACKUP_HOUR_UTC?: number | undefined;
  BACKUP_KEEP?: number | undefined;
  BACKUP_S3_BUCKET?: string | undefined;
  BACKUP_S3_ACCESS_KEY_ID?: string | undefined;
  BACKUP_S3_SECRET_ACCESS_KEY?: string | undefined;
  BACKUP_S3_ENDPOINT?: string | undefined;
  BACKUP_S3_REGION?: string | undefined;
  BACKUP_MONITOR_S3_ACCESS_KEY_ID?: string | undefined;
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY?: string | undefined;
};

/** Shared location settings used by both backup writers and the monitor. */
export function backupCommonConfigWarnings(value: BackupConfig): string[] {
  const warnings: string[] = [];
  if (value.BACKUP_ENABLED && !value.BACKUP_S3_BUCKET) {
    warnings.push(
      "BACKUP_ENABLED=true but BACKUP_S3_BUCKET is not set. Logical backups are enabled but no off-site bucket is configured — set BACKUP_S3_BUCKET, then configure the dump-writer and freshness-monitor credentials for the processes that need them.",
    );
  }
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (!value.BACKUP_S3_ENDPOINT && value.BACKUP_S3_REGION === "auto") {
    warnings.push(
      "BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. " +
        'The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
  }
  return warnings;
}

/** Freshness monitoring needs a distinct ListBucket-only identity. */
export function backupMonitorConfigWarnings(value: BackupConfig): string[] {
  const warnings = backupCommonConfigWarnings(value);
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (!value.BACKUP_MONITOR_S3_ACCESS_KEY_ID || !value.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY) {
    warnings.push(
      "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. " +
        "The freshness check needs a dedicated ListBucket-only monitor key.",
    );
  }
  const monitorKey = value.BACKUP_MONITOR_S3_ACCESS_KEY_ID;
  if (monitorKey && monitorKey === value.BACKUP_S3_ACCESS_KEY_ID) {
    warnings.push(
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness check needs a separate ListBucket-only key, not the dump read/write key.",
    );
  }
  return warnings;
}
