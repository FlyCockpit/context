import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * The restore CLI's test fixture, shared by restore.test.mjs (outcomes and
 * refusals) and restore-interrupts.test.mjs (signals and the bounded status
 * wait), two files so node --test runs them in parallel.
 */

export const restore = fileURLToPath(new URL("./restore.mjs", import.meta.url));

/**
 * Inert Postgres executables for the restore CLI and its lock handover.
 * RESTORE_FIXTURE_MODE:
 *   exit:<n>         the restore session exits <n> after it reads COMMIT
 *   dump-fail        pg_restore fails while producing the SQL (COMMIT never sent)
 *   hang-after-commit the restore session reads COMMIT, then never exits
 *   commit-unconfirmed the session reads COMMIT and exits 0 without confirming
 *                    it (the marker query after COMMIT never prints)
 *   hang-after-confirm the session confirms COMMIT, marks <receipt>.confirmed
 *                    1 s later, then never exits
 *   confirm-then-exit:<n> the session confirms COMMIT, then exits <n>
 *   hang-summary     the post-COMMIT migration summary query never returns
 *   dump-hang        pg_restore writes its SQL, marks <receipt>.dump, then hangs
 *                    (COMMIT is never sent)
 *   psql-gone:<n>    the restore session exits <n> as soon as it reads BEGIN,
 *                    while a grandchild keeps its stdout/stderr open (its exit
 *                    is visible before its "close"). The grandchild marks
 *                    <receipt>.gone once the session has been reaped; only
 *                    then does pg_restore end successfully (<receipt>.dump-done:
 *                    its pid and restore's end of its stdout), writing no SQL, and the
 *                    grandchild lets go once restore has handled that end.
 *   lock-spawn-fail  psql is removed after the last check before the lock
 *                    session, so spawning that session fails (ENOENT)
 *   dump-spawn-fail  pg_restore is removed after the writers check under the
 *                    lock, so spawning the restore stream fails (ENOENT)
 * Every mode writes the receipt file once the session has read COMMIT, and
 * confirms it (prints the \echo marker) except commit-unconfirmed,
 * hang-after-commit and exit:<n> with n > 0 (like psql with ON_ERROR_STOP,
 * whose COMMIT failed). Every mode that reads COMMIT first prints the
 * transaction id line (xid 777) that restore asks for right after BEGIN.
 * RESTORE_FIXTURE_XACT is what pg_xact_status('777') returns: committed,
 * aborted, unknown (the default), fail (the query fails),
 * in-progress-then-aborted ("in progress" twice, then "aborted"), hang (no
 * answer for 20 s), hang-with-descendant (it also leaves a 9 s child
 * holding its output pipes) or in-progress-then-hang ("in progress" for
 * 1.2 s after the first status query, then hang). The wait's arithmetic
 * (what each query and pause gets of the budget) is pollXactStatus's, tested
 * with a fake clock in lib.test.mjs; these modes prove the real process
 * boundary, including that restore hands a later query only what is left.
 * Every status query appends a line to <receipt>.xact;
 * the first writes its start time to <receipt>.xact-start. RESTORE_XACT_STATUS_WAIT_MS shortens the
 * restore's 15 s status wait to 2 s for these.
 */
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-cli-test-"));
  const archive = join(dir, "manual-20261113T000000Z.dump");
  const receipt = join(dir, "commit-observed.txt");
  writeFileSync(archive, "PGDMP-inert-test-archive");
  // The fixtures' `#!/usr/bin/env node` finds node here, so the spawn-failure
  // modes can run with a PATH of this directory alone.
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(
    join(dir, "pg_restore"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("pg_restore (PostgreSQL) 18.0");
else if (args.includes("--list")) {
  console.log("; Dbname: restore_fixture\\n1; 1 1 TABLE DATA public Fixture postgres");
  if (process.env.RESTORE_FIXTURE_MODE === "blob") console.log("2; 2613 16397 BLOB - 16397 postgres");
}
else if (args.includes("--file=-")) {
  const mode = process.env.RESTORE_FIXTURE_MODE;
  // psql-gone writes no SQL: a write into the exited session would be an EPIPE,
  // which makes restore stop pg_restore (a failed dump), not the case tested.
  if (!mode.startsWith("psql-gone:")) console.log("SELECT 1;");
  if (mode === "dump-fail") process.exitCode = 1;
  else if (mode === "dump-hang") {
    require("node:fs").writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".dump", "dump hanging");
    setInterval(() => {}, 1000);
  } else if (mode.startsWith("psql-gone:")) {
    const fs = require("node:fs");
    const receipt = process.env.RESTORE_FIXTURE_RECEIPT;
    const deadline = Date.now() + 10000;
    const poll = setInterval(() => {
      if (fs.existsSync(receipt + ".gone") || Date.now() > deadline) {
        clearInterval(poll);
        // Its pid and restore's end of its stdout, written whole (rename).
        // Node gives a child's stdio a Unix socketpair, so restore's end is
        // the peer of this process's fd 1 (ss -x names it); null without
        // /proc or ss.
        let peer = null;
        try {
          const own = /^socket:\\[(\\d+)\\]$/.exec(fs.readlinkSync("/proc/self/fd/1"))?.[1];
          const ss = require("node:child_process").spawnSync("ss", ["-x", "-a", "-n"], { encoding: "utf8" });
          for (const line of (ss.stdout ?? "").split("\\n")) {
            const cols = line.trim().split(/\\s+/);
            if (own && cols[5] === own && /^\\d+$/.test(cols[7] ?? "")) peer = "socket:[" + cols[7] + "]";
          }
        } catch {}
        fs.writeFileSync(receipt + ".dump-done.tmp", JSON.stringify({ pid: process.pid, peer }));
        fs.renameSync(receipt + ".dump-done.tmp", receipt + ".dump-done");
      }
    }, 20);
  }
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "psql"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.RESTORE_FIXTURE_MODE ?? "exit:0";
const args = process.argv.slice(2);
const queryIndex = args.indexOf("-c");
if (queryIndex !== -1) {
  const sql = args[queryIndex + 1];
  // The spawn-failure modes take their executable away for the next spawn.
  if (mode === "lock-spawn-fail" && sql.startsWith("SELECT count(*)")) fs.renameSync(__filename, __filename + ".gone");
  if (mode === "dump-spawn-fail" && sql.includes("pg_stat_activity")) {
    const pgRestore = require("node:path").join(__dirname, "pg_restore");
    fs.renameSync(pgRestore, pgRestore + ".gone");
  }
  if (sql.includes("pg_xact_status")) {
    const log = process.env.RESTORE_FIXTURE_RECEIPT + ".xact";
    fs.appendFileSync(log, sql + "\\n");
    const startFile = process.env.RESTORE_FIXTURE_RECEIPT + ".xact-start";
    if (!fs.existsSync(startFile)) fs.writeFileSync(startFile, String(Date.now()));
    const started = Number(fs.readFileSync(startFile, "utf8"));
    const xact = process.env.RESTORE_FIXTURE_XACT ?? "unknown";
    if (xact === "fail") process.exit(2);
    // Bounded beyond the harness's 10 s kill, so a regression that never kills
    // this query cannot leave it behind for good.
    const hang = () => setTimeout(() => process.exit(0), 20000);
    if (xact === "hang-with-descendant") require("node:child_process").spawn("sleep", ["9"], { stdio: "inherit" });
    if (xact === "hang" || xact === "hang-with-descendant") hang();
    else if (xact === "in-progress-then-hang") {
      if (Date.now() - started < 1200) console.log("in progress");
      else hang();
    }
    else {
      const asked = fs.readFileSync(log, "utf8").trim().split("\\n").length;
      console.log(xact === "in-progress-then-aborted" ? (asked <= 2 ? "in progress" : "aborted") : xact);
    }
  } else if (mode === "hang-summary" && sql.includes("_prisma_migrations") && fs.existsSync(process.env.RESTORE_FIXTURE_RECEIPT)) {
    fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".summary", "summary started");
    setInterval(() => {}, 1000);
  } else if (sql === "SHOW server_version_num") console.log("180000");
  else if (sql.includes("pg_stat_activity")) console.log("0|");
  else if (sql.startsWith("SELECT count(*)")) console.log("0");
  else console.log("f");
} else {
  let input = "";
  let locks = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!locks && input.includes("pg_try_advisory_lock")) {
      locks = true;
      process.stdout.write("t,t,t,4242\\n");
    }
    if (mode.startsWith("psql-gone:") && input.includes("BEGIN;")) {
      // Holds the session's stdout/stderr: marks .gone once the session is
      // reaped (its exit is then visible to restore). Bounded to 10 s.
      // It lets go only after restore has handled pg_restore's end, where it
      // decides about COMMIT: once restore has reaped pg_restore (its "exit"
      // is handled in the same libuv callback as the waitpid) AND closed its
      // end of pg_restore's stdout. After the EOF, Node shuts that socket
      // down and closes the fd in the post-poll pending phase (libuv >= 1.45)
      // and emits the stream's and then the child's "close" from the same
      // iteration's close callbacks; the session's EOFs, which this exit
      // causes only afterwards, are read in a later poll phase. The 100 ms
      // after that is margin, not the barrier. Without /proc or ss it lets
      // go 3 s after pg_restore ended.
      // (Restore's handling itself is not observable: Node destroys a
      // child's stdin as soon as it sees the child exit.)
      const holder = [
        'const fs = require("node:fs");',
        "const receipt = process.env.RESTORE_FIXTURE_RECEIPT;",
        "const pid = Number(process.env.FIXTURE_SESSION_PID);",
        "const restorePid = Number(process.env.FIXTURE_RESTORE_PID);",
        "const gone = (p) => { try { process.kill(p, 0); return false; } catch { return true; } };",
        'const fds = "/proc/" + restorePid + "/fd/";',
        "const holds = (pipe) => {",
        "  let list = [];",
        "  try { list = fs.readdirSync(fds); } catch {}",
        "  return list.some((fd) => { try { return fs.readlinkSync(fds + fd) === pipe; } catch { return false; } });",
        "};",
        "setTimeout(() => process.exit(0), 10000);",
        "const poll = setInterval(() => {",
        '  if (gone(pid) && !fs.existsSync(receipt + ".gone")) fs.writeFileSync(receipt + ".gone", "reaped");',
        '  if (!fs.existsSync(receipt + ".dump-done")) return;',
        '  const dump = JSON.parse(fs.readFileSync(receipt + ".dump-done", "utf8"));',
        "  if (dump.peer === null) { clearInterval(poll); setTimeout(() => process.exit(0), 3000); }",
        "  else if (gone(dump.pid) && !holds(dump.peer)) { clearInterval(poll); setTimeout(() => process.exit(0), 100); }",
        "}, 20);",
      ].join("\\n");
      require("node:child_process").spawn(process.execPath, ["-e", holder], {
        env: {
          ...process.env,
          FIXTURE_SESSION_PID: String(process.pid),
          FIXTURE_RESTORE_PID: String(process.ppid),
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      process.exit(Number(mode.slice(10)));
    }
  });
  process.stdin.on("end", () => {
    if (!input.includes("COMMIT;")) {
      process.exitCode = input.includes("BEGIN;") ? 3 : 0;
      return;
    }
    fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT, "commit observed");
    const xid = /SELECT '(cockpit-context-restore-xid-[0-9a-f]+:)' \\|\\| pg_current_xact_id\\(\\);/.exec(input);
    if (xid) console.log(xid[1] + "777");
    const marker = /\\\\echo (cockpit-context-restore-committed-[0-9a-f]+)\\n/.exec(input);
    const failedCommit = mode.startsWith("exit:") && mode !== "exit:0";
    if (marker && mode !== "commit-unconfirmed" && mode !== "hang-after-commit" && !failedCommit) console.log(marker[1]);
    if (mode.startsWith("confirm-then-exit:")) process.exitCode = Number(mode.slice(18));
    if (mode === "hang-after-confirm") {
      setTimeout(() => fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".confirmed", "confirmed"), 1000);
      setInterval(() => {}, 1000);
    }
    if (mode === "hang-after-commit") setInterval(() => {}, 1000);
    else if (mode.startsWith("exit:")) process.exitCode = Number(mode.slice(5));
  });
}
`,
    { mode: 0o755 },
  );
  const env = (mode, xact = "unknown") => ({
    // The spawn-failure modes must not find a real psql/pg_restore instead
    // (node's own directory may hold one too).
    PATH: mode.endsWith("spawn-fail") ? dir : `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
    RESTORE_FIXTURE_RECEIPT: receipt,
    RESTORE_FIXTURE_MODE: mode,
    RESTORE_FIXTURE_XACT: xact,
    RESTORE_XACT_STATUS_WAIT_MS: "2000",
  });
  const xactQueries = () => {
    try {
      return readFileSync(`${receipt}.xact`, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const xactStart = () => {
    try {
      return Number(readFileSync(`${receipt}.xact-start`, "utf8"));
    } catch {
      return null;
    }
  };
  const commit = () => {
    try {
      return readFileSync(receipt, "utf8");
    } catch {
      return null;
    }
  };
  return {
    dir,
    archive,
    receipt,
    env,
    commit,
    xactQueries,
    xactStart,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function runRestore({ mode = "exit:0", preview = false, xact = "unknown" } = {}) {
  const f = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [restore, f.archive, ...(preview ? [] : ["--confirm", "RESTORE:restore_fixture"])],
      // SIGKILL: a regression that traps SIGTERM cannot outlive the timeout.
      { env: f.env(mode, xact), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    assert.equal(result.error, undefined);
    return {
      ...result,
      commit: f.commit(),
      xactQueries: f.xactQueries(),
      xactStart: f.xactStart(),
      ended: Date.now(),
      output: result.stdout + result.stderr,
    };
  } finally {
    f.cleanup();
  }
}

/**
 * Start `restore.mjs <args>`, wait until the file `marker` exists, send
 * `signal`, collect the result. Bounded and self-reaping: restore runs in its
 * own process group, which is always SIGKILLed at the end.
 * @param {{ args: string[], env: NodeJS.ProcessEnv, marker: string, signal: NodeJS.Signals }} options
 */
export async function interruptAt({ args, env, marker, signal }) {
  const child = spawn(process.execPath, [restore, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a hung run can be reaped with its fixtures.
    detached: true,
  });
  const closed = once(child, "close").then(([code]) => code);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(marker), `the restore never reached the interrupt point:\n${output}`);
    child.kill(signal);
    // Bounded: a regression that ignores the signal fails instead of hanging.
    const code = await Promise.race([
      closed,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), 15_000);
      }),
    ]);
    assert.notEqual(code, "timeout", `the restore did not exit after ${signal}:\n${output}`);
    return { code, output };
  } finally {
    clearTimeout(timer);
    // Reap the whole group, even when restore itself already exited: a
    // fixture left behind would hold the pipes and hang the suite.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone (ESRCH).
    }
    await closed;
  }
}

/** Start a fixture restore, wait until `marker` exists, send `signal`, collect the result. */
export async function interruptRestore({ mode, marker, signal }) {
  const f = fixture();
  try {
    const result = await interruptAt({
      args: [f.archive, "--confirm", "RESTORE:restore_fixture"],
      env: f.env(mode),
      marker: marker(f),
      signal,
    });
    return { ...result, commit: f.commit() };
  } finally {
    f.cleanup();
  }
}
