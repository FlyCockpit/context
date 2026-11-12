import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-context/db");
const { appSettingFreshnessStore } = await import("./backup-freshness-store");

const db = prisma as unknown as {
  appSetting: { findUnique: MockInstance; upsert: MockInstance };
};

describe("appSettingFreshnessStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("writes one row per key with the expiry inside the envelope", async () => {
    await appSettingFreshnessStore.set("backup:freshness:abc", '{"state":"fresh"}', 60);
    expect(db.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: "backup:freshness:abc" },
      update: {
        value: JSON.stringify({
          expiresAt: "2026-10-24T12:01:00.000Z",
          value: '{"state":"fresh"}',
        }),
      },
      create: {
        key: "backup:freshness:abc",
        value: JSON.stringify({
          expiresAt: "2026-10-24T12:01:00.000Z",
          value: '{"state":"fresh"}',
        }),
      },
    });
  });

  it("returns the value until it expires, then null", async () => {
    db.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ expiresAt: "2026-10-24T12:01:00.000Z", value: "v" }),
    });
    await expect(appSettingFreshnessStore.get("k")).resolves.toBe("v");
    vi.setSystemTime(new Date("2026-10-24T12:01:00.000Z"));
    await expect(appSettingFreshnessStore.get("k")).resolves.toBeNull();
  });

  it("treats a missing or malformed row as unknown", async () => {
    db.appSetting.findUnique.mockResolvedValueOnce(null);
    await expect(appSettingFreshnessStore.get("k")).resolves.toBeNull();
    db.appSetting.findUnique.mockResolvedValueOnce({ value: "{not json" });
    await expect(appSettingFreshnessStore.get("k")).resolves.toBeNull();
    db.appSetting.findUnique.mockResolvedValueOnce({ value: '{"value":"v"}' });
    await expect(appSettingFreshnessStore.get("k")).resolves.toBeNull();
  });
});
