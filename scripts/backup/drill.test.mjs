import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { archiveCreatedAt, archiveTables, drillVerdict, parseDrillArgs } from "./drill.mjs";

const LISTING = `;
; Archive created at 2026-11-11 03:00:01 UTC
;     dbname: cockpit_context
;
215; 1259 16390 TABLE public user cockpit_context
3420; 0 16390 TABLE DATA public user cockpit_context
3421; 0 16400 TABLE DATA public _prisma_migrations cockpit_context
3422; 0 16410 TABLE DATA public session cockpit_context
3423; 0 16410 SEQUENCE SET public x_seq cockpit_context
`;

describe("restore drill", () => {
  it("reads the tables with data and the creation time from pg_restore --list", () => {
    assert.deepEqual(archiveTables(LISTING), [
      "public._prisma_migrations",
      "public.session",
      "public.user",
    ]);
    assert.equal(archiveCreatedAt(LISTING), Date.UTC(2026, 10, 11, 3, 0, 1));
    assert.equal(archiveCreatedAt("no header"), null);
  });

  it("passes only with every table back and a clean migration history", () => {
    const counts = new Map([
      ["public._prisma_migrations", 3],
      ["public._cockpit_context_migration", 3],
      ["public._cockpit_context_instance", 0],
      ["public._cockpit_context_hold", 1],
      ["public.session", 0],
      ["public.user", 2],
    ]);
    const expected = archiveTables(LISTING);
    const migrations = { applied: 3, unfinished: 0 };
    assert.deepEqual(drillVerdict({ expected, counts, migrations }), { pass: true, problems: [] });

    const missing = new Map(counts);
    missing.delete("public._cockpit_context_migration");
    assert.equal(drillVerdict({ expected: [], counts: missing, migrations }).pass, false);
    missing.delete("public.user");
    assert.match(
      drillVerdict({ expected, counts: missing, migrations }).problems.join(),
      /public\.user/,
    );
    assert.equal(drillVerdict({ expected, counts, migrations: null }).pass, false);
    assert.equal(
      drillVerdict({ expected, counts, migrations: { applied: 3, unfinished: 1 } }).pass,
      false,
    );
    assert.equal(
      drillVerdict({ expected, counts, migrations: { applied: 0, unfinished: 0 } }).pass,
      false,
    );
  });

  it("accepts only a source and the s3 pins; never an option that widens the restore", () => {
    assert.deepEqual(parseDrillArgs(["latest"]), { source: "latest", pins: [] });
    assert.deepEqual(parseDrillArgs(["s3://b/k.dump", "--etag", '"abc"', "--version-id=v1"]), {
      source: "s3://b/k.dump",
      pins: ["--etag", '"abc"', "--version-id", "v1"],
    });
    for (const argv of [
      [],
      ["--replace"],
      ["latest", "--replace"],
      ["/backups/x.dump", "--allow-active-connections"],
      ["s3://b/k.dump", "--etag", "e", "--skip-snapshot"],
      ["s3://b/k.dump", "--confirm", "RESTORE:prod"],
      ["s3://b/k.dump", "--etag"],
      ["s3://b/k.dump", "--etag", "a", "--etag", "b"],
      ["latest", "--etag", "e"],
      ["latest", "extra"],
    ])
      assert.throws(() => parseDrillArgs(argv), /usage: restore-drill/, JSON.stringify(argv));
  });
});
