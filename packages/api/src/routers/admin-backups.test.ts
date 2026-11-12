import type { Session } from "@cockpit-context/auth";
import type prisma from "@cockpit-context/db";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

const storeGet = vi.fn();
const backupEnabled = vi.fn(() => true);
const backupMisconfiguration = vi.fn((): { state: "misconfigured"; reason: string } | null => null);
const backupSetupMissing = vi.fn(
  (): { state: "setup-missing"; reason: string; checkedAt: string; maxAgeHours: number } | null =>
    null,
);

vi.mock("../lib/backup-freshness-store", () => ({
  appSettingFreshnessStore: { get: storeGet, set: vi.fn() },
}));

vi.mock("../lib/backup-freshness", () => ({
  backupFreshnessEnabled: () => backupEnabled(),
  misconfiguredBackupFreshness: () => backupMisconfiguration(),
  setupMissingBackupFreshness: () => backupSetupMissing(),
  readBackupFreshness: async (store: { get: (key: string) => Promise<string | null> }) => {
    const raw = await store.get("backup:freshness");
    return raw ? JSON.parse(raw) : null;
  },
}));

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<typeof prisma>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@cockpit-context/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { adminBackupsRouter } = await import("./admin-backups");

function buildContext(role: "admin" | "user"): Context {
  return {
    clientIp: undefined,
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role,
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "test-session-id",
        userId: "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    } as Session,
  };
}

describe("adminBackupsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue(null);
    backupSetupMissing.mockReturnValue(null);
  });

  it("reports backups as not configured without reading the store", async () => {
    backupEnabled.mockReturnValue(false);
    const client = createRouterClient(adminBackupsRouter, { context: buildContext("admin") });

    await expect(client.status()).resolves.toEqual({ configured: false, status: null });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("returns the recorded freshness verdict when backups are configured", async () => {
    backupEnabled.mockReturnValue(true);
    const verdict = {
      state: "stale",
      checkedAt: "2026-09-08T00:00:00.000Z",
      latestKey: "cockpit-context/prod/database/daily-20260908T030000Z.dump",
      latestAt: "2026-09-05T03:00:00.000Z",
      ageHours: 69,
      maxAgeHours: 36,
    };
    storeGet.mockResolvedValue(JSON.stringify(verdict));
    const client = createRouterClient(adminBackupsRouter, { context: buildContext("admin") });

    await expect(client.status()).resolves.toEqual({ configured: true, status: verdict });
    expect(storeGet).toHaveBeenCalledWith("backup:freshness");
  });

  it('reports enabled backups without a bucket as setup-missing rather than as "off"', async () => {
    backupEnabled.mockReturnValue(true);
    backupSetupMissing.mockReturnValue({
      state: "setup-missing",
      checkedAt: "2026-09-08T00:00:00.000Z",
      maxAgeHours: 36,
      reason: "BACKUP_S3_BUCKET is not set.",
    });
    const client = createRouterClient(adminBackupsRouter, { context: buildContext("admin") });

    await expect(client.status()).resolves.toEqual({
      configured: true,
      status: {
        state: "setup-missing",
        checkedAt: "2026-09-08T00:00:00.000Z",
        maxAgeHours: 36,
        reason: "BACKUP_S3_BUCKET is not set.",
      },
    });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it('reports a set-but-unusable bucket as misconfigured rather than as "off"', async () => {
    // Hiding this behind `configured: false` means the admin card disappears
    // and the operator never learns that no backups are being taken.
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue({
      state: "misconfigured",
      reason: "BACKUP_S3_REGION must be a real AWS region.",
    });
    const client = createRouterClient(adminBackupsRouter, { context: buildContext("admin") });

    await expect(client.status()).resolves.toEqual({
      configured: true,
      status: { state: "misconfigured", reason: "BACKUP_S3_REGION must be a real AWS region." },
    });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("hides backup status from non-admins", async () => {
    const client = createRouterClient(adminBackupsRouter, { context: buildContext("user") });
    await expect(client.status()).rejects.toBeInstanceOf(ORPCError);
  });
});
