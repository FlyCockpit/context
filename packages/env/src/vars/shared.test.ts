import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sharedVars } from "./shared.js";

describe("migration entrypoint controls", () => {
  it("applies migrations by default and accepts an explicit opt-out", () => {
    expect(sharedVars.MIGRATE_ON_START.parse(undefined)).toBe(true);
    expect(sharedVars.MIGRATE_ON_START.parse("false")).toBe(false);
    expect(sharedVars.MIGRATE_ON_START.safeParse("yes").success).toBe(false);
  });

  it("allows an unregistered local process and rejects malformed instance IDs", () => {
    expect(sharedVars.COCKPIT_CONTEXT_INSTANCE_ID.parse(undefined)).toBeUndefined();
    const id = randomUUID();
    expect(sharedVars.COCKPIT_CONTEXT_INSTANCE_ID.parse(id)).toBe(id);
    expect(sharedVars.COCKPIT_CONTEXT_INSTANCE_ID.safeParse("instance-1").success).toBe(false);
  });

  it("bounds the VPS HTTP port", () => {
    const schema = sharedVars.COCKPIT_CONTEXT_HTTP_PORT;
    expect(schema.parse(undefined)).toBe(3000);
    expect(schema.parse("65535")).toBe(65535);
    for (const value of ["0", "65536", "3000.5", "http"]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

describe("backup scheduling controls", () => {
  it("requires an explicit daily schedule and a valid UTC hour", () => {
    expect(sharedVars.BACKUP_SCHEDULE.parse(undefined)).toBe("off");
    expect(sharedVars.BACKUP_SCHEDULE.parse("daily")).toBe("daily");
    expect(sharedVars.BACKUP_SCHEDULE.safeParse("hourly").success).toBe(false);
    expect(sharedVars.BACKUP_HOUR_UTC.parse("0")).toBe(0);
    expect(sharedVars.BACKUP_HOUR_UTC.parse("23")).toBe(23);
    for (const value of ["-1", "24", "3.5", "night"]) {
      expect(sharedVars.BACKUP_HOUR_UTC.safeParse(value).success).toBe(false);
    }
  });

  it("bounds local retention and keeps the off-site prefix specific to this instance", () => {
    expect(sharedVars.BACKUP_KEEP.parse(undefined)).toBe(14);
    expect(sharedVars.BACKUP_KEEP.parse("1")).toBe(1);
    expect(sharedVars.BACKUP_KEEP.parse("365")).toBe(365);
    for (const value of ["0", "366", "1.5", "forever"]) {
      expect(sharedVars.BACKUP_KEEP.safeParse(value).success).toBe(false);
    }
    expect(sharedVars.BACKUP_S3_PREFIX.parse(undefined)).toBe("cockpit-context/prod/database");
  });
});
