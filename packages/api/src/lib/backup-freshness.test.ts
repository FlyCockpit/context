import { beforeEach, describe, expect, it, vi } from "vitest";

const inertDatabaseUrl = [
  "post",
  "gresql://reader:",
  "inert@db.example.com:5432/cockpit_context?sslmode=require",
].join("");

const envState = {
  BACKUP_ENABLED: true,
  BACKUP_SCHEDULE: "off" as const,
  BACKUP_S3_BUCKET: "backups",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "monitor-key",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "monitor-secret",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_ENDPOINT: "https://r2.example.com",
  BACKUP_S3_PREFIX: "/database/",
  BACKUP_S3_FORCE_PATH_STYLE: false,
  BACKUP_MAX_AGE_HOURS: 36,
  DATABASE_URL: inertDatabaseUrl,
};

vi.mock("@cockpit-context/env/shared", () => ({ env: envState }));

const send = vi.fn();
const s3Clients = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(options: Record<string, unknown>) {
      s3Clients(options);
    }

    send = send;
  },
  ListObjectsV2Command: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const {
  BACKUP_CHECKER_INTERVAL_HOURS,
  backupNamespace,
  backupFreshnessKey,
  backupFreshnessEnabled,
  backupFreshnessNeedsAttention,
  checkBackupFreshness,
  evaluateBackupFreshness,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  refreshBackupFreshness,
  setupMissingBackupFreshness,
  writeBackupFreshness,
} = await import("./backup-freshness");
const { backupMonitorConfigWarnings } = await import("@cockpit-context/env/backup-config");
const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("evaluateBackupFreshness", () => {
  it("uses the writer's flat namespace and normalizes only surrounding slashes", () => {
    expect(backupNamespace("/cockpit-context/prod/database/")).toBe(
      "cockpit-context/prod/database",
    );
    expect(backupNamespace("team/backups/")).toBe("team/backups");
    expect(() => backupNamespace("///")).toThrow("must not be empty");
  });

  it("keys cached verdicts by the bucket location rather than database credentials", () => {
    const original = backupFreshnessKey();
    const oldUrl = envState.DATABASE_URL;
    const oldPrefix = envState.BACKUP_S3_PREFIX;
    try {
      envState.DATABASE_URL = "postgresql://rotated:inert@other.example.com/other";
      expect(backupFreshnessKey()).toBe(original);
      envState.BACKUP_S3_PREFIX = "other/backups";
      expect(backupFreshnessKey()).not.toBe(original);
    } finally {
      envState.DATABASE_URL = oldUrl;
      envState.BACKUP_S3_PREFIX = oldPrefix;
    }
  });

  it("keeps the inert monitor URL equivalent after source fragmentation", () => {
    const parsed = new URL(envState.DATABASE_URL);
    expect(parsed).toMatchObject({
      protocol: "postgresql:",
      username: "reader",
      password: "inert",
      hostname: "db.example.com",
      port: "5432",
      pathname: "/cockpit_context",
      search: "?sslmode=require",
    });
  });

  it("is fresh inside the window", () => {
    const status = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T03:00:00.000Z"),
      },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 9, maxAgeHours: 36 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale past the window", () => {
    const status = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-06T03:00:00.000Z"),
      },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "stale", ageHours: 57 });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("flags an empty bucket", () => {
    const status = evaluateBackupFreshness(null, NOW, 36);
    expect(status.state).toBe("empty");
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("tolerates a few minutes of clock skew", () => {
    const status = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T12:02:00.000Z"),
      },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 0 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale when the newest backup is dated in the future", () => {
    // Clamping a negative age to 0 would read as fresh forever — the newest
    // object never ages past the limit, so a stopped cron would never alert.
    const status = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-09T12:00:00.000Z"),
      },
      NOW,
      36,
    );
    expect(status).toMatchObject({
      state: "stale",
      ageHours: 0,
      reason: "future-timestamp",
    });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("misconfiguration", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("reports no misconfiguration when the backup config is usable", () => {
    expect(backupFreshnessEnabled()).toBe(true);
    expect(misconfiguredBackupFreshness(NOW)).toBeNull();
    expect(setupMissingBackupFreshness(NOW)).toBeNull();
  });

  it("uses the real monitor validator for invalid monitor profiles", () => {
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: undefined,
      }),
    ).toEqual([
      "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. The freshness check needs a dedicated ListBucket-only monitor key.",
    ]);
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ACCESS_KEY_ID: "dump-key",
        BACKUP_S3_SECRET_ACCESS_KEY: "dump-secret",
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: "dump-key",
      }),
    ).toContain(
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness check needs a separate ListBucket-only key, not the dump read/write key.",
    );
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ENDPOINT: undefined,
      }),
    ).toContain(
      'BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
  });
});

describe("checkBackupFreshness", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("pages through the listing and picks the newest dump by date, not key order", async () => {
    send
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextContinuationToken: "t1",
        Contents: [
          {
            Key: "database/daily-20260901T030000Z.dump",
            LastModified: new Date("2026-09-01T03:00:00Z"),
          },
          {
            Key: "database/pre-migrate-20260908T030000Z.dump",
            LastModified: new Date("2026-09-08T03:00:00Z"),
          },
          {
            Key: "database/manual-notes.txt",
            LastModified: new Date("2026-09-08T11:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Contents: [
          {
            Key: "database/manual-20260907T030000Z.dump",
            LastModified: new Date("2026-09-07T03:00:00Z"),
          },
        ],
      });

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({
      state: "fresh",
      latestKey: "database/pre-migrate-20260908T030000Z.dump",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      Bucket: "backups",
      Prefix: "database/",
      MaxKeys: 1000,
    });
    expect(send.mock.calls[1]?.[0]?.input).toMatchObject({ ContinuationToken: "t1" });
    expect(s3Clients).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "monitor-key",
          secretAccessKey: "monitor-secret",
        },
      }),
    );
  });

  it("recognizes all writer labels with the daily scheduler off and rejects nested/partial/snapshot keys", async () => {
    for (const label of ["manual", "pre-migrate", "pre-drop", "daily"]) {
      send.mockResolvedValueOnce({
        Contents: [
          {
            Key: `database/${label}-20260908T030000Z-42.dump`,
            LastModified: NOW,
            Size: 100,
          },
        ],
      });
      expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "fresh" });
    }
    send.mockResolvedValueOnce({
      Contents: [
        "database/old-target/daily-20260908T030000Z.dump",
        "database/pre-restore-20260908T030000Z.dump",
        "database/.daily-20260908T030000Z.dump.partial",
        "database/backup-20260908T030000Z.dump",
        "other/daily-20260908T030000Z.dump",
      ].map((Key) => ({ Key, LastModified: NOW, Size: 100 })),
    });
    expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "empty" });
  });

  it("refuses to bless a partial listing when the bounded page limit is exhausted", async () => {
    send.mockResolvedValue({ IsTruncated: true, NextContinuationToken: "next", Contents: [] });
    expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "error" });
    expect(send).toHaveBeenCalledTimes(50);
  });

  it("redacts token-bearing network errors before storing a verdict", async () => {
    send.mockRejectedValueOnce(
      new Error("request https://fixture:private-token@example.test/path failed"),
    );
    const verdict = await checkBackupFreshness(NOW);
    expect(verdict.state).toBe("error");
    expect(JSON.stringify(verdict)).not.toContain("private-token");
  });

  it("turns a listing failure into an error verdict instead of throwing", async () => {
    send.mockReset();
    send.mockRejectedValueOnce(new Error("AccessDenied"));

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({
      state: "error",
      message: "Backup bucket listing failed. Check monitor credentials and connectivity.",
    });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("refreshBackupFreshness", () => {
  it("recomputes stale from wall-clock age even when the cache still says fresh", () => {
    const cached = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-06T12:00:00.000Z"),
      },
      new Date("2026-09-07T12:00:00.000Z"),
      36,
    );
    expect(cached.state).toBe("fresh");

    const refreshed = refreshBackupFreshness(cached, new Date("2026-09-08T12:00:00.000Z"));
    expect(refreshed).toMatchObject({ state: "stale", ageHours: 48 });
  });

  it("marks a fresh verdict stale when the checker has not run within its interval plus an hour", () => {
    const checkedAt = new Date("2026-09-08T11:00:00.000Z");
    const cached = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T10:00:00.000Z"),
      },
      checkedAt,
      36,
    );
    const refreshed = refreshBackupFreshness(
      cached,
      new Date(checkedAt.getTime() + (BACKUP_CHECKER_INTERVAL_HOURS + 1) * 3_600_000 + 60_000),
    );
    expect(refreshed?.state).toBe("stale");
  });

  it("keeps a fresh verdict fresh around the scheduled run, up to interval plus an hour", () => {
    const checkedAt = new Date("2026-09-08T11:00:00.000Z");
    const cached = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T10:00:00.000Z"),
      },
      checkedAt,
      36,
    );
    // Just past one interval: the next run is due but may not have landed yet.
    const justPastInterval = refreshBackupFreshness(
      cached,
      new Date(checkedAt.getTime() + BACKUP_CHECKER_INTERVAL_HOURS * 3_600_000 + 60_000),
    );
    expect(justPastInterval?.state).toBe("fresh");
    // Exactly interval + 1 h is still inside the grace window.
    const atGraceEdge = refreshBackupFreshness(
      cached,
      new Date(checkedAt.getTime() + (BACKUP_CHECKER_INTERVAL_HOURS + 1) * 3_600_000),
    );
    expect(atGraceEdge?.state).toBe("fresh");
  });

  it("drops a cached future-timestamp reason once the dump is no longer in the future", () => {
    const checkedAt = new Date("2026-09-08T11:00:00.000Z");
    const cached = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T12:00:00.000Z"),
      },
      checkedAt,
      36,
    );
    expect(cached).toMatchObject({ state: "stale", reason: "future-timestamp" });

    const refreshed = refreshBackupFreshness(cached, new Date("2026-09-08T13:00:00.000Z"));
    expect(refreshed?.state).toBe("fresh");
    expect(refreshed).not.toHaveProperty("reason");
  });

  it("keeps the future-timestamp reason while the dump is still in the future", () => {
    const cached = evaluateBackupFreshness(
      {
        key: "database/daily-20260908T030000Z.dump",
        lastModified: new Date("2026-09-08T12:00:00.000Z"),
      },
      new Date("2026-09-08T11:00:00.000Z"),
      36,
    );
    const refreshed = refreshBackupFreshness(cached, new Date("2026-09-08T11:30:00.000Z"));
    expect(refreshed).toMatchObject({ state: "stale", reason: "future-timestamp" });
  });

  it("treats malformed cache JSON as unknown on read", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(backupFreshnessKey(), "{not json");
    await expect(readBackupFreshness(cache)).resolves.toBeNull();
  });

  it("rejects structured cache missing maxAgeHours even when otherwise recent", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-08T11:00:00.000Z",
        latestKey: "database/daily-20260908T030000Z.dump",
        ageHours: 1,
      }),
    );
    await expect(
      readBackupFreshness(cache, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("reconciles a cached 720h threshold to the current configured limit", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-06T12:00:00.000Z",
        latestKey: "database/daily-20260908T030000Z.dump",
        ageHours: 48,
        maxAgeHours: 720,
      }),
    );
    await expect(
      readBackupFreshness(cache, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toMatchObject({ state: "stale", maxAgeHours: 36 });
  });

  it("rejects structured cache with future checkedAt", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2099-01-01T00:00:00.000Z",
        latestAt: "2026-09-01T12:00:00.000Z",
        latestKey: "database/daily-20260908T030000Z.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(cache)).resolves.toBeNull();
  });

  it("rejects structured cache with invalid latestAt", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "not-a-date",
        latestKey: "database/daily-20260908T030000Z.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(cache)).resolves.toBeNull();
  });
});

describe("freshness store", () => {
  it("does not trust an unbound verdict left under the former shared cache key", async () => {
    const store = new Map([
      [
        "backup:freshness",
        JSON.stringify({
          state: "fresh",
          checkedAt: NOW.toISOString(),
          latestAt: NOW.toISOString(),
          latestKey: "database/other-target/backup.dump",
          ageHours: 0,
          maxAgeHours: 36,
        }),
      ],
    ]);
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    await expect(readBackupFreshness(cache, NOW)).resolves.toBeNull();
    expect(cache.get).toHaveBeenCalledWith(backupFreshnessKey());
    expect(backupFreshnessKey()).not.toBe("backup:freshness");
  });

  it("round-trips through the store with a TTL and treats garbage as unknown", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    };
    const status = evaluateBackupFreshness(null, NOW, 36);

    await writeBackupFreshness(cache, status);
    expect(cache.set).toHaveBeenCalledWith(
      backupFreshnessKey(),
      JSON.stringify(status),
      3 * 24 * 60 * 60,
    );
    const read = await readBackupFreshness(cache, NOW);
    expect(read).toEqual(status);
  });
});
