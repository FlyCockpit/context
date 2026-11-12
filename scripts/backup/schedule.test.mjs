import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dailyPrunePlan,
  dueAtStart,
  dumpDay,
  healthOf,
  migrationGate,
  nextAction,
  nextRunAt,
  recoveredLastSuccess,
  scheduleConfig,
} from "./schedule.mjs";

const HOUR = 3_600_000;

describe("scheduleConfig", () => {
  it("is off unless BACKUP_SCHEDULE=daily", () => {
    assert.deepEqual(scheduleConfig({}), { enabled: false });
    assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "off" }), { enabled: false });
    assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "daily" }), {
      enabled: true,
      hourUtc: 3,
      keep: 14,
    });
    assert.deepEqual(
      scheduleConfig({ BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "0", BACKUP_KEEP: "30" }),
      { enabled: true, hourUtc: 0, keep: 30 },
    );
  });
  it("rejects values it would otherwise guess at", () => {
    for (const env of [
      { BACKUP_SCHEDULE: "hourly" },
      { BACKUP_SCHEDULE: "true" },
      { BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "24" },
      { BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "3.5" },
      { BACKUP_SCHEDULE: "daily", BACKUP_KEEP: "0" },
    ])
      assert.throws(() => scheduleConfig(env), /BACKUP_/, JSON.stringify(env));
  });
});

describe("timing", () => {
  it("runs next at the configured UTC hour, today or tomorrow", () => {
    const now = Date.UTC(2026, 10, 11, 2, 30);
    assert.equal(nextRunAt(now, 3), Date.UTC(2026, 10, 11, 3));
    assert.equal(nextRunAt(now, 2), Date.UTC(2026, 10, 12, 2));
    assert.equal(nextRunAt(Date.UTC(2026, 11, 31, 23), 3), Date.UTC(2027, 0, 1, 3));
    // Exactly on the hour: the run that just happened is not repeated.
    assert.equal(nextRunAt(Date.UTC(2026, 10, 11, 3), 3), Date.UTC(2026, 10, 12, 3));
  });
  it("backs up at start when there is no success or the last scheduled run was missed", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    assert.equal(dueAtStart(null, now, 3), true);
    assert.equal(dueAtStart(now - 25 * HOUR, now, 3), true);
    assert.equal(dueAtStart(now - 2 * HOUR, now, 3), false);
    // Today's 03:00 run already succeeded (03:10): not due.
    assert.equal(dueAtStart(Date.UTC(2026, 10, 11, 3, 10), now, 3), false);
    // Restart at 03:05 after yesterday's 03:10 success: today's run is missed → due
    // (under 24 h old, but older than today's scheduled time).
    const restart = Date.UTC(2026, 10, 11, 3, 5);
    assert.equal(dueAtStart(Date.UTC(2026, 10, 10, 3, 10), restart, 3), true);
    // Restart at 02:00, before today's slot, after yesterday's run: wait for 03:00.
    assert.equal(dueAtStart(Date.UTC(2026, 10, 10, 3, 10), Date.UTC(2026, 10, 11, 2), 3), false);
  });
});

describe("healthOf", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const base = { enabled: true, startedAt: now - 2 * HOUR, lastSuccess: null, lastFailure: null };
  it("is healthy when off, or after a recent success", () => {
    assert.equal(healthOf({ ...base, enabled: false }, now).healthy, true);
    assert.equal(healthOf({ ...base, lastSuccess: now - HOUR }, now).healthy, true);
    assert.equal(healthOf({ ...base, startedAt: now - 60_000 }, now).healthy, true);
  });
  it("is unhealthy after a failure, a stale success, or no success at all", () => {
    assert.equal(healthOf({ ...base, lastFailure: now - HOUR }, now).healthy, false);
    assert.equal(
      healthOf({ ...base, lastSuccess: now - 3 * HOUR, lastFailure: now - HOUR }, now).healthy,
      false,
    );
    assert.equal(
      healthOf({ ...base, lastSuccess: now - HOUR, lastFailure: now - 3 * HOUR }, now).healthy,
      true,
    );
    assert.equal(healthOf({ ...base, lastSuccess: now - 27 * HOUR }, now).healthy, false);
    assert.equal(healthOf(base, now).healthy, false);
  });
});

describe("retention: one dump per UTC day", () => {
  it("keeps the newest dump of each of the newest N days, whatever the retries", () => {
    const names = [
      "daily-20261108T030000Z.dump",
      "daily-20261109T030000Z.dump",
      "daily-20261110T030000Z.dump",
      // Hourly retries on the 11th (upload failing): only the newest stays.
      "daily-20261111T030000Z.dump",
      "daily-20261111T040000Z.dump",
      "daily-20261111T050000Z.dump",
      "daily-20261111T050000Z-77.dump",
      "manual-20261101T000000Z.dump",
      "pre-migrate-20261101T000000Z.dump",
      ".daily-20261111T060000Z.dump.partial",
    ];
    assert.deepEqual(dailyPrunePlan(names, 3), [
      "daily-20261108T030000Z.dump",
      "daily-20261111T030000Z.dump",
      "daily-20261111T040000Z.dump",
      "daily-20261111T050000Z.dump",
    ]);
    // Twelve failed retries never push the older days out of a 14-day window.
    const retries = Array.from(
      { length: 12 },
      (_, hour) => `daily-20261111T${String(hour + 3).padStart(2, "0")}0000Z.dump`,
    );
    const history = ["daily-20261109T030000Z.dump", "daily-20261110T030000Z.dump"];
    const kept = [...history, ...retries].filter(
      (name) => !dailyPrunePlan([...history, ...retries], 14).includes(name),
    );
    assert.deepEqual(kept, [...history, "daily-20261111T140000Z.dump"]);
    assert.deepEqual(dailyPrunePlan([], 14), []);
    assert.equal(dumpDay("daily-20261111T030000Z.dump"), "20261111");
    assert.equal(dumpDay("daily-20261111T030000Z-1-2.dump"), "20261111");
    assert.equal(dumpDay("manual-20261111T030000Z.dump"), null);
  });
});

describe("retries and restarts", () => {
  const now = Date.UTC(2026, 10, 11, 9);
  it("re-uploads today's dump instead of dumping again; a new day dumps afresh", () => {
    assert.equal(nextAction("daily-20261111T030000Z.dump", now), "upload");
    assert.equal(nextAction("daily-20261110T030000Z.dump", now), "dump");
    assert.equal(nextAction(null, now), "dump");
  });
  it("recovers the remembered success; a bare local dump counts only without uploads", () => {
    assert.equal(recoveredLastSuccess({ lastSuccess: now - HOUR }, now, true), now - HOUR);
    assert.equal(recoveredLastSuccess({ lastSuccess: null }, now, true), null);
    assert.equal(recoveredLastSuccess(null, now - HOUR, true), null);
    assert.equal(recoveredLastSuccess(null, now - HOUR, false), now - HOUR);
    assert.equal(recoveredLastSuccess(null, null, false), null);
  });
});

describe("migrationGate", () => {
  const idle = { runnerHeld: false, prismaHeld: false, hasHistory: true, unfinished: 0 };
  it("dumps only when no migration runs and none is unfinished", () => {
    assert.equal(migrationGate(idle), "ready");
    // The first migration creates _prisma_migrations early, under the runner lock.
    assert.equal(migrationGate({ ...idle, runnerHeld: true, unfinished: 1 }), "busy");
    assert.equal(migrationGate({ ...idle, prismaHeld: true }), "busy");
    assert.equal(migrationGate({ ...idle, restoreHeld: true }), "busy");
    assert.equal(migrationGate({ ...idle, unfinished: 1 }), "failed");
    assert.equal(migrationGate({ ...idle, hasHistory: false }), "new-install");
  });
});
