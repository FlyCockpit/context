import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    BACKUP_ENABLED: true,
    BACKUP_S3_BUCKET: "backups",
    BACKUP_S3_PREFIX: "database",
  },
}));

vi.mock("@cockpit-context/env/shared", () => ({
  env: mockEnv,
}));

const checkBackupFreshness = vi.fn();
const writeBackupFreshness = vi.fn();
vi.mock("@cockpit-context/api/lib/backup-freshness", async () => {
  const actual = await import("@cockpit-context/api/lib/backup-freshness");
  return {
    backupFreshnessNeedsAttention: actual.backupFreshnessNeedsAttention,
    checkBackupFreshness,
    writeBackupFreshness,
  };
});

const freshnessStore = { get: vi.fn(), set: vi.fn() };
vi.mock("@cockpit-context/api/lib/backup-freshness-store", () => ({
  appSettingFreshnessStore: freshnessStore,
}));
const sendOperationalAlert = vi.fn();
vi.mock("./operational-alerts.js", () => ({ sendOperationalAlert }));
vi.mock("@cockpit-context/mailer", () => ({ escapeHtml: (value: string) => value }));

const { runBackupFreshnessCheck } = await import("./check-backup-freshness.js");

const fresh = {
  state: "fresh" as const,
  checkedAt: "2026-09-08T12:00:00.000Z",
  latestKey: "cockpit-context/prod/database/daily-20260908T030000Z.dump",
  latestAt: "2026-09-08T03:00:00.000Z",
  ageHours: 9,
  maxAgeHours: 36,
};

describe("runBackupFreshnessCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockEnv.BACKUP_ENABLED = true;
  });

  it("skips queued work when logical backups are disabled", async () => {
    mockEnv.BACKUP_ENABLED = false;

    await expect(runBackupFreshnessCheck("job-1")).resolves.toBeNull();

    expect(checkBackupFreshness).not.toHaveBeenCalled();
    expect(writeBackupFreshness).not.toHaveBeenCalled();
    expect(sendOperationalAlert).not.toHaveBeenCalled();
  });

  it("records a fresh verdict and stays quiet", async () => {
    checkBackupFreshness.mockResolvedValue(fresh);

    await expect(runBackupFreshnessCheck("job-1")).resolves.toEqual(fresh);

    expect(writeBackupFreshness).toHaveBeenCalledWith(freshnessStore, fresh);
    expect(sendOperationalAlert).not.toHaveBeenCalled();
  });

  it("alerts admins when the backup config itself is unusable", async () => {
    // No dump will ever land in this state, so it has to alert like a stale
    // backup rather than passing silently as "backups are off".
    const misconfigured = {
      state: "misconfigured" as const,
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
      reason: "BACKUP_S3_REGION must be a real AWS region.",
    };
    checkBackupFreshness.mockResolvedValue(misconfigured);

    await expect(runBackupFreshnessCheck("job-1")).resolves.toEqual(misconfigured);

    expect(writeBackupFreshness).toHaveBeenCalledWith(freshnessStore, misconfigured);
    expect(sendOperationalAlert).toHaveBeenCalledTimes(1);
    expect(sendOperationalAlert.mock.calls[0]?.[0]?.html).toContain(
      "BACKUP_S3_REGION must be a real AWS region.",
    );
  });

  it("alerts admins on a stale verdict with a daily cooldown", async () => {
    const stale = { ...fresh, state: "stale" as const, ageHours: 60 };
    checkBackupFreshness.mockResolvedValue(stale);

    await runBackupFreshnessCheck("job-1");

    expect(writeBackupFreshness).toHaveBeenCalledWith(freshnessStore, stale);
    expect(sendOperationalAlert).toHaveBeenCalledTimes(1);
    const alert = sendOperationalAlert.mock.calls[0]?.[0];
    expect(alert).toMatchObject({
      source: "backup.check-freshness",
      message: "stale",
      cooldownSeconds: 24 * 60 * 60,
    });
    expect(alert.html).toContain("cockpit-context/prod/database/daily-20260908T030000Z.dump");
    expect(alert.html).toContain("backups");
  });

  it("treats an empty bucket and a listing error as attention states", async () => {
    checkBackupFreshness.mockResolvedValueOnce({
      state: "empty",
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
    });
    await runBackupFreshnessCheck("job-1");

    checkBackupFreshness.mockResolvedValueOnce({
      state: "error",
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
      message: "AccessDenied",
    });
    await runBackupFreshnessCheck("job-1");

    expect(sendOperationalAlert).toHaveBeenCalledTimes(2);
    expect(sendOperationalAlert.mock.calls[1]?.[0]?.html).toContain("AccessDenied");
  });

  it("still records the verdict before alerting, so the dashboard never lags the email", async () => {
    const stale = { ...fresh, state: "stale" as const };
    checkBackupFreshness.mockResolvedValue(stale);
    const order: string[] = [];
    writeBackupFreshness.mockImplementation(async () => {
      order.push("write");
    });
    sendOperationalAlert.mockImplementation(async () => {
      order.push("alert");
    });

    await runBackupFreshnessCheck("job-1");

    expect(order).toEqual(["write", "alert"]);
  });
});
