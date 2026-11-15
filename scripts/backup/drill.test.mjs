import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import {
  archiveCreatedAt,
  archiveListing,
  archiveTables,
  drillVerdict,
  parseDrillArgs,
} from "./drill.mjs";

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

  it("never passes without reading the archive's table list", () => {
    // Every table and a clean history are present: only the list is missing.
    const counts = new Map([
      ["public._prisma_migrations", 3],
      ["public._cockpit_context_migration", 3],
      ["public._cockpit_context_instance", 0],
      ["public._cockpit_context_hold", 1],
      ["public.session", 0],
      ["public.user", 2],
    ]);
    const migrations = { applied: 3, unfinished: 0 };
    const unread = drillVerdict({ expected: null, counts, migrations, listingError: "boom" });
    assert.equal(unread.pass, false);
    assert.match(unread.problems.join(), /could not read the archive's table list \(boom\)/);
    const empty = drillVerdict({ expected: [], counts, migrations });
    assert.equal(empty.pass, false);
    assert.match(empty.problems.join(), /holds no table data/);
    // The control tables are still required when the list is unreadable.
    const noControl = new Map(counts);
    noControl.delete("public._cockpit_context_hold");
    assert.match(
      drillVerdict({ expected: null, counts: noControl, migrations }).problems.join(),
      /tables missing after the restore: public\._cockpit_context_hold/,
    );
  });

  it("resolves `latest` once, before the restore, and checks that same archive", () => {
    // main() is not importable without running a restore; pin its order instead.
    const source = readFileSync(new URL("./drill.mjs", import.meta.url), "utf8");
    const body = source.slice(
      source.indexOf("async function main("),
      source.indexOf("/** `--etag`"),
    );
    assert.equal(body.split('resolveLocal("latest")').length, 2, "one `latest` scan in main");
    const scan = body.indexOf('resolveLocal("latest")');
    assert.ok(scan !== -1 && scan < body.indexOf("const restoreArgs"));
    assert.match(body, /source = newest;/);
    assert.match(body, /archiveListing\(source, pins, env\)/);
  });

  it("reads the table list of a raw, a gzip-wrapped and an s3:// source", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drill-test-"));
    try {
      const raw = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(600, 1)]);
      const rawFile = path.join(dir, "a.dump");
      const gzFile = path.join(dir, "a.dump.gz");
      writeFileSync(rawFile, raw);
      writeFileSync(gzFile, gzipSync(raw));
      /** @type {Buffer[]} */
      const seen = [];
      const list = (/** @type {string} */ file) => {
        seen.push(readFileSync(file));
        return { status: 0, stdout: LISTING, stderr: "" };
      };
      for (const source of [rawFile, gzFile])
        assert.equal(await archiveListing(source, [], {}, { list }), LISTING);
      /** @type {unknown[]} */
      const downloads = [];
      const download = async (/** @type {{ dest: string }} */ args) => {
        downloads.push({ ...args, dest: undefined });
        writeFileSync(args.dest, gzipSync(raw));
      };
      assert.equal(
        await archiveListing(
          "s3://b/k.dump.gz",
          ["--etag", '"e1"', "--version-id", "v1"],
          {},
          {
            download,
            list,
          },
        ),
        LISTING,
      );
      assert.deepEqual(downloads, [
        {
          location: { bucket: "b", key: "k.dump.gz" },
          eTag: '"e1"',
          versionId: "v1",
          dest: undefined,
        },
      ]);
      // pg_restore always sees the unwrapped archive, never the gzip bytes.
      assert.equal(seen.length, 3);
      for (const bytes of seen) assert.ok(bytes.equals(raw));
      await assert.rejects(archiveListing("s3://b/k", [], {}, { download, list }), /--etag/);
      await assert.rejects(
        archiveListing(rawFile, [], {}, { list: () => ({ status: 1, stdout: "", stderr: "bad" }) }),
        /pg_restore --list failed: bad/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
