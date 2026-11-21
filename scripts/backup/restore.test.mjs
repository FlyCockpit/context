import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture, restore, runRestore } from "./restore-fixture.mjs";

test("restore preview is a refusal (exit 3) that never invokes a transaction", () => {
  const result = runRestore({ preview: true });
  // REFUSED_EXIT: nothing was changed, so host.sh may start the writers again.
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /preview only/);
  assert.match(result.output, /--confirm RESTORE:restore_fixture/);
});

test("a committed restore exits 0 and reports completion", () => {
  const result = runRestore();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /Restore complete/);
  // A database restore does not bring back /data clones or the keyring.
  assert.match(
    result.output,
    /\/data snapshot clones[\s\S]*COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring/,
  );
  assert.doesNotMatch(result.output, /REFUSED|FATAL/);
});

test("a psql failure after COMMIT was sent reports an uncertain outcome, never 'rolled back; unchanged'", () => {
  // psql exit 7 is not ON_ERROR_STOP's 3, and the server cannot say (unknown).
  const result = runRestore({ mode: "exit:7" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /restore failed after COMMIT was sent/);
  assert.match(result.output, /uncertain/);
  assert.doesNotMatch(result.output, /rolled back|is unchanged/);
  // It asked the server about the transaction id the session printed.
  assert.deepEqual(result.xactQueries, ["SELECT coalesce(pg_xact_status('777'::xid8), 'unknown')"]);
});

test("a psql that stopped on an SQL error (ON_ERROR_STOP, exit 3) without confirming COMMIT is rolled back: exit 4", () => {
  // COMMIT was written, but psql stopped at an earlier statement (or at a
  // failed COMMIT): nothing after COMMIT can fail, so nothing committed.
  const result = runRestore({ mode: "exit:3" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /ROLLED BACK: restore failed \(psql exit 3, pg_restore exit 0\)\. psql stopped on an SQL error \(ON_ERROR_STOP\) before confirming COMMIT, so the transaction was rolled back; "restore_fixture" is unchanged/,
  );
  assert.doesNotMatch(result.output, /uncertain|Restore complete|FATAL/);
  // Provable from psql's status alone: the server is not asked.
  assert.deepEqual(result.xactQueries, []);
});

test("an unconfirmed COMMIT the server reports aborted is rolled back: exit 4", () => {
  for (const [mode, xact, asked] of [
    ["exit:7", "aborted", 1],
    ["commit-unconfirmed", "aborted", 1],
    // Still "in progress" at first (the backend is finishing): it waits.
    ["exit:2", "in-progress-then-aborted", 3],
  ]) {
    const result = runRestore({ mode, xact });
    const label = `${mode} + ${xact}`;
    assert.equal(result.status, 4, `${label}:\n${result.output}`);
    assert.match(
      result.output,
      /the server reports the restore transaction aborted, so the transaction was rolled back; "restore_fixture" is unchanged/,
      label,
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/, label);
    assert.equal(result.xactQueries.length, asked, label);
  }
});

test("an unconfirmed COMMIT the server reports committed says the restore committed, exit 1", () => {
  const result = runRestore({ mode: "exit:7", xact: "committed" });
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /the restore session failed before confirming COMMIT, but the server reports the restore transaction committed \(psql exit 7\)\. "restore_fixture" is restored/,
  );
  assert.doesNotMatch(result.output, /rolled back|is uncertain|Restore complete\./);
});

test("an unconfirmed COMMIT whose status the server cannot give stays uncertain, exit 1", () => {
  const result = runRestore({ mode: "exit:7", xact: "fail" });
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /COMMIT not confirmed; the server reports the restore transaction as unavailable/,
  );
  assert.match(result.output, /is uncertain/);
  assert.doesNotMatch(result.output, /rolled back|is unchanged/);
});

test("a session that confirmed COMMIT and then failed says the restore committed, exit 1", () => {
  const result = runRestore({ mode: "confirm-then-exit:2" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /the restore session confirmed COMMIT, then failed \(psql exit 2\)\. .* is restored \(the transaction committed\)/,
  );
  assert.doesNotMatch(result.output, /Restore complete\.|rolled back|is uncertain/);
});

test("a failure before COMMIT was sent is rolled back and says so: exit 4", () => {
  const result = runRestore({ mode: "dump-fail" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /COMMIT was never sent, so the transaction was rolled back/);
  assert.doesNotMatch(result.output, /uncertain/);
});

test("a restore session that already exited is never sent COMMIT: rolled back, never 'uncertain' or 'complete'", () => {
  // The session's exit is visible before its "close" (a grandchild holds its
  // output open) when pg_restore finishes: COMMIT must not count as sent.
  for (const exit of ["3", "0"]) {
    const result = runRestore({ mode: `psql-gone:${exit}` });
    assert.equal(result.status, 4, result.output);
    assert.equal(result.commit, null);
    // pg_restore succeeded: only the session's early exit kept COMMIT back.
    assert.match(
      result.output,
      /psql exit \d+, pg_restore exit 0\)\. COMMIT was never sent, so the transaction was rolled back/,
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/);
  }
});

test("a lock session that cannot be spawned is a refusal (exit 3), never an uncaught error", () => {
  const result = runRestore({ mode: "lock-spawn-fail" });
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /REFUSED: could not open the lock session: spawn psql ENOENT/);
  assert.doesNotMatch(result.output, /Restoring into|Unhandled 'error' event|uncertain/);
});

test("a pg_restore that cannot be spawned sends no COMMIT: rolled back, never 'uncertain'", () => {
  const result = runRestore({ mode: "dump-spawn-fail" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, null);
  assert.match(
    result.output,
    /restore failed \(psql exit \d+, pg_restore exit -2\)\. COMMIT was never sent, so the transaction was rolled back/,
  );
  assert.doesNotMatch(result.output, /Unhandled 'error' event|uncertain|Restore complete/);
});

test("a COMMIT the session never confirms is uncertain, never 'Restore complete'", () => {
  const result = runRestore({ mode: "commit-unconfirmed" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /restore failed after COMMIT was sent \(psql exit 0, COMMIT not confirmed; the server reports the restore transaction as unknown\)\. The outcome .* is uncertain/,
  );
  assert.doesNotMatch(result.output, /Restore complete|rolled back/);
});

test("an archive with large objects is refused before anything changes (exit 3)", () => {
  const result = runRestore({ mode: "blob" });
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /REFUSED: the archive contains large objects/);
});

test("a source the checks reject with an ordinary error (S3 bucket mismatch) is a refusal, exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-s3-refusal-"));
  try {
    const result = spawnSync(
      process.execPath,
      [restore, "s3://some-other-bucket/backups/manual-20261113T000000Z.dump", "--etag", "abc"],
      {
        env: {
          PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
          DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
          BACKUP_S3_BUCKET: "the-backup-bucket",
          BACKUP_S3_ACCESS_KEY_ID: "test-key",
          BACKUP_S3_SECRET_ACCESS_KEY: "test-secret",
          BACKUP_S3_ENDPOINT: "http://127.0.0.1:9",
          BACKUP_S3_REGION: "us-east-1",
        },
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 3, output);
    assert.match(output, /REFUSED: /);
    assert.doesNotMatch(output, /Restoring into|test-secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the signal handlers are installed before the --list and `latest` scans of /backups", () => {
  // /backups is a fixed path, so a stalled mount cannot be simulated here;
  // pin the order in the source instead.
  const source = readFileSync(restore, "utf8");
  const handlers = source.indexOf("process.once(signal, () => {");
  const scan = source.indexOf('if (args.source === "latest")');
  assert.ok(handlers > 0 && scan > 0, "both markers exist");
  assert.ok(handlers < scan, "signal handlers come before the latest scan");
  assert.ok(handlers < source.indexOf("if (args.list) {"), "and before the --list scan");
});

test("a usage error is a refusal, exit 3", () => {
  const result = spawnSync(process.execPath, [restore, "--no-such-flag"], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /REFUSED: /);
});

/** util-linux `script`, which runs a command on a pseudo-terminal. */
const scriptBinary = ["/usr/bin/script", "/bin/script"].find((path) => existsSync(path));

/**
 * Run a guided restore on a pseudo-terminal (util-linux `script`), type `keys`
 * at its confirmation prompt and collect the result. Bounded and self-reaping
 * like {@link interruptAt}.
 * @param {string} keys
 */
async function answerGuidedPrompt(keys) {
  const f = fixture();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn(
    /** @type {string} */ (scriptBinary),
    ["-qefc", [process.execPath, restore, f.archive, "--guided"].map(quote).join(" "), "/dev/null"],
    { env: f.env("exit:0"), stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  const closed = once(child, "close").then(([code]) => code);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    let output = "";
    let typed = false;
    const collect = (chunk) => {
      output += chunk;
      if (!typed && output.includes("[y/N]")) {
        typed = true;
        child.stdin.write(keys);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const code = await Promise.race([
      closed,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), 15_000);
      }),
    ]);
    assert.notEqual(code, "timeout", `the guided restore did not exit:\n${output}`);
    assert.ok(typed, `the guided restore never asked:\n${output}`);
    return { code, output, commit: f.commit() };
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone (ESRCH).
    }
    await closed;
    f.cleanup();
  }
}

test("Ctrl-C, Ctrl-D or a 'no' at the guided prompt is a cancel: exit 3, nothing changed", {
  skip: scriptBinary ? false : "needs util-linux script for a pseudo-terminal",
}, async () => {
  for (const [name, keys] of [
    ["Ctrl-C", "\x03"],
    ["Ctrl-D", "\x04"],
    ["no", "n\r"],
  ]) {
    const result = await answerGuidedPrompt(keys);
    assert.equal(result.code, 3, `${name}: ${result.output}`);
    assert.equal(result.commit, null, name);
    assert.match(result.output, /REFUSED: cancelled — nothing was changed/, name);
    assert.doesNotMatch(result.output, /Restoring into|rolled back|uncertain/, name);
  }
  // The same prompt answered "y" does restore (the cancels above are real cancels).
  const confirmed = await answerGuidedPrompt("y\r");
  assert.equal(confirmed.code, 0, confirmed.output);
  assert.equal(confirmed.commit, "commit observed");
});
