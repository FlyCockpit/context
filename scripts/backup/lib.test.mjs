import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  detectArchiveFormat,
  expectedConfirmation,
  guidedAnswerConfirms,
  guidedQuestion,
  parseRestoreArgs,
  parseS3Source,
  pgEnvFromUrl,
  pickLatest,
  pollXactStatus,
  shellQuote,
  sortBackups,
  UsageError,
} from "./lib.mjs";

describe("pgEnvFromUrl", () => {
  it("maps a URL to libpq variables and decodes credentials", () => {
    assert.deepEqual(
      pgEnvFromUrl(
        "postgresql://app%40x:p%24ss%20w@db.internal:6543/my_db?schema=public&sslmode=require",
      ),
      {
        PGHOST: "db.internal",
        PGPORT: "6543",
        PGDATABASE: "my_db",
        PGUSER: "app@x",
        PGPASSWORD: "p$ss w",
        PGSSLMODE: "require",
      },
    );
  });

  it("defaults the port and unwraps IPv6 hosts", () => {
    const env = pgEnvFromUrl("postgres://u@[::1]/cockpit_context");
    assert.equal(env.PGHOST, "::1");
    assert.equal(env.PGPORT, "5432");
    assert.equal(env.PGPASSWORD, undefined);
  });

  it("refuses URLs without a database or with the wrong scheme", () => {
    assert.throws(() => pgEnvFromUrl(undefined), /not set/);
    assert.throws(() => pgEnvFromUrl("postgresql://u:p@h:5432/"), /name exactly one database/);
    assert.throws(() => pgEnvFromUrl("mysql://u:p@h/db"), /postgres/);
    assert.throws(() => pgEnvFromUrl("not a url"), /valid URL/);
  });
});

describe("detectArchiveFormat", () => {
  const custom = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(600, 1)]);
  it("recognizes pg_dump custom archives", () => {
    assert.equal(detectArchiveFormat(custom), "custom");
  });
  it("recognizes gzip wrappers (Dokploy .sql.gz holds pg_dump -Fc | gzip)", () => {
    const wrapped = gzipSync(custom);
    assert.equal(detectArchiveFormat(wrapped.subarray(0, 512)), "gzip");
  });
  it("recognizes tar archives", () => {
    const tar = Buffer.alloc(512);
    tar.write("toc.dat", 0, "latin1");
    tar.write("ustar", 257, "latin1");
    assert.equal(detectArchiveFormat(tar), "tar");
  });
  it("identifies plain SQL so it can be refused", () => {
    assert.equal(
      detectArchiveFormat(Buffer.from("--\n-- PostgreSQL database dump\n--\n")),
      "plain-sql",
    );
    assert.equal(detectArchiveFormat(Buffer.from("SET statement_timeout = 0;\n")), "plain-sql");
  });
  it("returns unknown for anything else, including empty input", () => {
    assert.equal(detectArchiveFormat(Buffer.alloc(0)), "unknown");
    assert.equal(detectArchiveFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "unknown");
  });
});

describe("parseS3Source", () => {
  it("splits bucket and key", () => {
    assert.deepEqual(parseS3Source("s3://bkt/database/pre-migrate-1.dump"), {
      bucket: "bkt",
      key: "database/pre-migrate-1.dump",
    });
    assert.equal(parseS3Source("/backups/x.dump"), null);
  });
  it("rejects a bucket without a key", () => {
    assert.throws(() => parseS3Source("s3://bkt"), UsageError);
    assert.throws(() => parseS3Source("s3://bkt/dir/"), UsageError);
  });
});

describe("parseRestoreArgs", () => {
  it("parses a full local invocation and drops a leading CMD word", () => {
    assert.deepEqual(
      parseRestoreArgs(["restore", "/backups/a.dump", "--confirm", "RESTORE:app", "--replace"]),
      {
        source: "/backups/a.dump",
        confirm: "RESTORE:app",
        replace: true,
        allowActiveConnections: false,
        skipSnapshot: false,
        etag: null,
        versionId: null,
        help: false,
        list: false,
        guided: false,
      },
    );
  });

  it("lists without a source, and guided restores ask instead of taking --confirm", () => {
    assert.equal(parseRestoreArgs(["--list"]).list, true);
    assert.throws(() => parseRestoreArgs(["--list", "/backups/a.dump"]), /--list takes no source/);
    const guided = parseRestoreArgs(["latest", "--guided"]);
    assert.equal(guided.source, "latest");
    assert.equal(guided.guided, true);
    assert.throws(
      () => parseRestoreArgs(["latest", "--guided", "--confirm", "RESTORE:app"]),
      /--guided asks/,
    );
    assert.throws(() => parseRestoreArgs(["latest", "--guided", "--replace"]), /--guided asks/);
  });

  it("accepts --flag=value forms and S3 pins", () => {
    const args = parseRestoreArgs([
      "s3://b/k.dump",
      '--etag="abc"',
      "--version-id=v1",
      "--confirm=RESTORE:db",
    ]);
    assert.equal(args.etag, '"abc"');
    assert.equal(args.versionId, "v1");
    assert.equal(args.confirm, "RESTORE:db");
  });

  it("leaves confirm unset for a preview", () => {
    assert.equal(parseRestoreArgs(["/backups/a.dump"]).confirm, null);
  });

  it("rejects malformed invocations", () => {
    assert.throws(() => parseRestoreArgs([]), /Missing <source>/);
    assert.throws(() => parseRestoreArgs(["a", "b"]), /one <source>/);
    assert.throws(() => parseRestoreArgs(["a", "--confirm"]), /needs a value/);
    assert.throws(() => parseRestoreArgs(["a", "--confirm", "--replace"]), /needs a value/);
    assert.throws(() => parseRestoreArgs(["a", "--force"]), /Unknown option/);
    assert.throws(() => parseRestoreArgs(["a", "--replace=yes"]), /does not take a value/);
    assert.throws(() => parseRestoreArgs(["/backups/a", "--etag", "x"]), /only to s3/);
    assert.throws(() => parseRestoreArgs(["/backups/a", "--skip-snapshot"]), /--replace/);
  });

  it("returns help without requiring a source", () => {
    assert.equal(parseRestoreArgs(["--help"]).help, true);
  });

  it("allows a source that starts with a dash after --", () => {
    assert.equal(parseRestoreArgs(["--", "-odd.dump"]).source, "-odd.dump");
  });
});

describe("helpers", () => {
  it("binds the confirmation to the database name", () => {
    assert.equal(expectedConfirmation("cockpit_context"), "RESTORE:cockpit_context");
  });
  it("guided: replacing a database with data needs its name typed; an empty one takes y", () => {
    assert.match(
      guidedQuestion("cockpit_context", true),
      /Type the database name \(cockpit_context\)/,
    );
    assert.match(guidedQuestion("cockpit_context", false), /\[y\/N\]/);
    assert.equal(guidedAnswerConfirms("cockpit_context", "cockpit_context", true), true);
    assert.equal(guidedAnswerConfirms("  cockpit_context\n", "cockpit_context", true), true);
    for (const answer of [
      "y",
      "yes",
      "Y",
      "",
      "Cockpit_context",
      "cockpit_contex",
      "RESTORE:cockpit_context",
    ])
      assert.equal(guidedAnswerConfirms(answer, "cockpit_context", true), false, answer);
    for (const answer of ["y", "Yes", " y "])
      assert.equal(guidedAnswerConfirms(answer, "cockpit_context", false), true, answer);
    for (const answer of ["", "n", "cockpit_context", "yep"])
      assert.equal(guidedAnswerConfirms(answer, "cockpit_context", false), false, answer);
  });
  it("quotes shell values only when needed", () => {
    assert.equal(shellQuote("/backups/a.dump"), "/backups/a.dump");
    assert.equal(shellQuote('"etag"'), `'"etag"'`);
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});

describe("backups in the volume", () => {
  const at = (name, mtimeMs) => ({ name, mtimeMs, size: 1 });
  it("lists restorable files newest first, skipping hidden and partial ones", () => {
    const sorted = sortBackups([
      at("pre-migrate-20261101T000000Z.dump", 1),
      at(".daily-20261103T030000Z.dump.partial", 9),
      at("daily-20261103T030000Z.dump", 3),
      at("notes.txt", 8),
      at("dokploy-2026-11-02.sql.gz", 2),
    ]).map((entry) => entry.name);
    assert.deepEqual(sorted, [
      "daily-20261103T030000Z.dump",
      "dokploy-2026-11-02.sql.gz",
      "pre-migrate-20261101T000000Z.dump",
    ]);
  });
  it("latest is the newest backup that is not a pre-restore snapshot", () => {
    assert.equal(
      pickLatest([
        at("daily-20261102T030000Z.dump", 2),
        at("pre-restore-20261103T120000Z.dump", 5),
        at("manual-20261103T110000Z.dump", 4),
      ]),
      "manual-20261103T110000Z.dump",
    );
    assert.equal(pickLatest([at("pre-restore-20261103T120000Z.dump", 5)]), null);
    assert.equal(pickLatest([]), null);
  });
});

describe("pollXactStatus", () => {
  /**
   * A fake clock and status server. `answers` is consumed one per query: a
   * string is printed after `cost` ms; "hang" never answers, so the query is
   * killed at its timeout (the clock moves by all of it) and rejects.
   */
  function server(answers, { cost = 30 } = {}) {
    let clock = 1_000_000;
    const queries = [];
    const sleeps = [];
    const query = async (sql, timeoutMs) => {
      queries.push({ sql, at: clock, timeoutMs });
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer === "hang" || answer === "fail") {
        clock += answer === "hang" ? timeoutMs : cost;
        throw new Error(answer === "hang" ? "killed at the timeout" : "psql exited 2");
      }
      clock += Math.min(cost, timeoutMs);
      return answer;
    };
    const sleep = async (ms) => {
      sleeps.push(ms);
      clock += ms;
    };
    return { query, queries, sleep, sleeps, now: () => clock, start: clock };
  }

  it("asks once and returns a final answer as is", async () => {
    for (const answer of ["committed", "aborted"]) {
      const s = server([answer]);
      assert.equal(await pollXactStatus("777", s.query, { waitMs: 2000, ...s }), answer);
      assert.deepEqual(
        s.queries.map((q) => [q.sql, q.timeoutMs]),
        [["SELECT coalesce(pg_xact_status('777'::xid8), 'unknown')", 2000]],
      );
    }
  });

  it("never queries without a transaction id of digits only", async () => {
    for (const xid of [null, "", "77a", "777; SELECT 1", "-1"]) {
      const s = server(["committed"]);
      assert.equal(await pollXactStatus(xid, s.query, { waitMs: 2000, ...s }), "unknown", xid);
      assert.equal(s.queries.length, 0, String(xid));
    }
  });

  it("reads a failed query as unavailable and any other output as unknown", async () => {
    let s = server(["fail"]);
    assert.equal(
      await pollXactStatus("777", s.query, { waitMs: 2000, ...s }),
      "unavailable (the status query failed)",
    );
    s = server(["unknown"]);
    assert.equal(await pollXactStatus("777", s.query, { waitMs: 2000, ...s }), "unknown");
  });

  it("waits out an 'in progress' transaction, pausing at most 250 ms between queries", async () => {
    const s = server(["in progress", "in progress", "aborted"]);
    assert.equal(await pollXactStatus("777", s.query, { waitMs: 2000, ...s }), "aborted");
    assert.equal(s.queries.length, 3);
    assert.deepEqual(s.sleeps, [250, 250]);
  });

  it("stops at the deadline while the transaction stays in progress, each query bounded by what is left", async () => {
    const s = server(["in progress"]);
    assert.equal(await pollXactStatus("777", s.query, { waitMs: 2000, ...s }), "still in progress");
    assert.ok(s.queries.length >= 2, `${s.queries.length} queries`);
    for (const q of s.queries) assert.equal(q.timeoutMs, s.start + 2000 - q.at);
    // It waited out the whole budget, and not a millisecond more.
    assert.equal(s.now(), s.start + 2000);
    assert.ok(s.sleeps.every((ms) => ms >= 0 && ms <= 250));
  });

  it("is one total budget: a query that hangs after 'in progress' is killed at the deadline", async () => {
    // "in progress" for the first 1.2 s, then a query that never answers.
    const s = server(["in progress", "in progress", "in progress", "in progress", "hang"], {
      cost: 50,
    });
    assert.equal(
      await pollXactStatus("777", s.query, { waitMs: 2000, ...s }),
      "unavailable (the status query failed)",
    );
    const hung = s.queries.at(-1);
    assert.ok(hung.at - s.start >= 1000, `the hanging query started at ${hung.at - s.start} ms`);
    // Killed at the 2 s deadline, not 2 s after it started.
    assert.equal(hung.timeoutMs, s.start + 2000 - hung.at);
    assert.equal(s.now(), s.start + 2000);
  });

  it("a query that hangs at once is killed at the deadline", async () => {
    const s = server(["hang"]);
    assert.equal(
      await pollXactStatus("777", s.query, { waitMs: 2000, ...s }),
      "unavailable (the status query failed)",
    );
    assert.deepEqual(
      s.queries.map((q) => q.timeoutMs),
      [2000],
    );
    assert.equal(s.now(), s.start + 2000);
  });
});
