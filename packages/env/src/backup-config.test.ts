import { describe, expect, it } from "vitest";
import { backupCommonConfigWarnings, backupMonitorConfigWarnings } from "./backup-config";

const monitor = {
  BACKUP_S3_BUCKET: "fixture-bucket",
  BACKUP_S3_REGION: "eu-west-1",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "fixture-monitor",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "fixture-monitor-secret",
};

describe("backup monitor configuration", () => {
  it("does not require writer credentials or a daily schedule", () => {
    expect(backupMonitorConfigWarnings({ ...monitor, BACKUP_SCHEDULE: "off" })).toEqual([]);
  });

  it("keeps monitor credential isolation when a writer is also configured", () => {
    expect(
      backupMonitorConfigWarnings({ ...monitor, BACKUP_S3_ACCESS_KEY_ID: "fixture-monitor" }),
    ).toEqual([expect.stringContaining("separate ListBucket-only key")]);
    expect(backupMonitorConfigWarnings({ BACKUP_S3_BUCKET: "fixture-bucket" })).toEqual([
      expect.stringContaining("dedicated ListBucket-only monitor key"),
    ]);
  });

  it("reports missing off-site setup separately from intentional monitoring opt-out", () => {
    expect(backupCommonConfigWarnings({ BACKUP_ENABLED: true })).toEqual([
      expect.stringContaining("BACKUP_S3_BUCKET is not set"),
    ]);
    expect(backupCommonConfigWarnings({ BACKUP_ENABLED: false })).toEqual([]);
  });
});
