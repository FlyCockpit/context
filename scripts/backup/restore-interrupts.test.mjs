import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, interruptAt, interruptRestore, restore, runRestore } from "./restore-fixture.mjs";

test("the status wait is one total budget: a hanging query is killed at the deadline, a later one gets only what is left, and a killed query's descendants cannot hold it open", () => {
  for (const [xact, queries] of [
    // A client stalled on a dead connection is killed at the deadline.
    ["hang", (n) => n === 1],
    // "in progress" for 1.2 s, then a query that hangs: killed at the 2 s
    // deadline, not 2 s after it started (3.2 s or more). This is the real
    // process boundary for the budget restore hands each later query.
    ["in-progress-then-hang", (n) => n > 1],
    // The killed client left a 9 s child holding its stdout/stderr.
    ["hang-with-descendant", (n) => n === 1],
  ]) {
    const started = Date.now();
    const result = runRestore({ mode: "exit:7", xact });
    assert.equal(result.status, 1, `${xact}:\n${result.output}`);
    assert.match(
      result.output,
      /the server reports the restore transaction as unavailable \(the status query failed\)/,
      xact,
    );
    assert.ok(queries(result.xactQueries.length), `${xact}: ${result.xactQueries.length} queries`);
    assert.match(result.output, /is uncertain/, xact);
    assert.doesNotMatch(result.output, /rolled back|is unchanged/, xact);
    // It waited out the 2 s budget (which starts after this spawn)...
    const waited = result.ended - started;
    assert.ok(waited >= 2_000, `${xact}: gave up after ${waited} ms`);
    // ...and stopped at it: from the first status query to the restore's
    // exit, the 2 s budget plus reporting, never another full budget, the
    // 9 s child or the harness's 10 s kill.
    const took = result.ended - result.xactStart;
    assert.ok(took < 3_000, `${xact}: the status wait and exit took ${took} ms`);
  }
});

test("a signal while the restore transaction is open, before COMMIT was sent, is rolled back and says so: exit 4", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const result = await interruptRestore({
      mode: "dump-hang",
      marker: (f) => `${f.receipt}.dump`,
      signal,
    });
    assert.equal(result.code, 4, result.output);
    assert.equal(result.commit, null);
    assert.match(
      result.output,
      new RegExp(
        `ROLLED BACK: interrupted by ${signal} before COMMIT; the unfinished restore transaction is rolled back`,
      ),
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/);
  }
});

test("a signal after COMMIT succeeded exits 0: restore completed; then interrupted", async () => {
  // The summary query after COMMIT hangs; SIGTERM arrives while it runs.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const result = await interruptRestore({
      mode: "hang-summary",
      marker: (f) => `${f.receipt}.summary`,
      signal,
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commit, "commit observed");
    assert.match(result.output, new RegExp(`Restore completed; then interrupted by ${signal}`));
    assert.doesNotMatch(result.output, /rolled back|uncertain|REFUSED/);
  }
});

test("a signal after the session confirmed COMMIT, before psql exits, exits 0: restore completed", async () => {
  const result = await interruptRestore({
    mode: "hang-after-confirm",
    marker: (f) => `${f.receipt}.confirmed`,
    signal: "SIGTERM",
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /Restore completed; then interrupted by SIGTERM/);
  assert.doesNotMatch(result.output, /rolled back|is uncertain|REFUSED/);
});

test("a signal after COMMIT was sent but before it was confirmed is uncertain, never 'rolled back'", async () => {
  const result = await interruptRestore({
    mode: "hang-after-commit",
    marker: (f) => f.receipt,
    signal: "SIGTERM",
  });
  assert.equal(result.code, 143, result.output);
  assert.match(
    result.output,
    /interrupted by SIGTERM after COMMIT was sent; the outcome for the target is uncertain/,
  );
  assert.doesNotMatch(result.output, /rolled back|Restore completed/);
});

test("a signal while the source is still being verified is a refusal, exit 3 (nothing changed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-signal-"));
  try {
    const archive = join(dir, "manual-20261113T000000Z.dump");
    writeFileSync(archive, "PGDMP-inert-test-archive");
    // pg_restore --list hangs, as a slow archive check would.
    writeFileSync(
      join(dir, "pg_restore"),
      `#!/bin/sh
if [ "$1" = --version ]; then echo "pg_restore (PostgreSQL) 18.0"; exit 0; fi
touch "${join(dir, "listing")}"
exec sleep 30
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "psql"), "#!/bin/sh\necho 180000\n", { mode: 0o755 });
    const { code, output } = await interruptAt({
      args: [archive, "--confirm", "RESTORE:restore_fixture"],
      env: {
        PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
      },
      marker: join(dir, "listing"),
      signal: "SIGINT",
    });
    assert.equal(code, 3, output);
    assert.match(output, /cancelled by SIGINT before the restore started — nothing was changed/);
    assert.doesNotMatch(output, /rolled back|uncertain/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal after a reported failure keeps its exit status (1 or 4) and prints no second outcome", async () => {
  // A test-only preload holds the process once at beforeExit (the failure is
  // reported, the exit code set) and marks it, so the signal lands while the
  // process winds down. Without the guard the handler would add a second,
  // contradictory outcome: "Restore completed" (exit 0) after a commit,
  // "interrupted ... rolled back" before COMMIT. The preload
  // can also inject a throw, to reach the two failure reports of the
  // top-level catch: after the commit (the closing summary's log throws) and
  // once the restore started, before COMMIT (spawning pg_restore throws).
  for (const [mode, inject, signal, reported, status] of [
    [
      "confirm-then-exit:2",
      "",
      "SIGTERM",
      /the restore session confirmed COMMIT, then failed \(psql exit 2\)/,
      1,
    ],
    ["dump-fail", "", "SIGHUP", /COMMIT was never sent, so the transaction was rolled back/, 4],
    [
      "exit:0",
      "after-commit",
      "SIGTERM",
      /FATAL: the restore was committed, then: injected after commit/,
      1,
    ],
    [
      "exit:0",
      "at-apply",
      "SIGINT",
      /ROLLED BACK: injected at apply\. COMMIT was never sent, so the restore transaction was rolled back; the target is unchanged/,
      4,
    ],
  ]) {
    const f = fixture();
    const held = join(f.dir, "held-at-exit");
    const hold = join(f.dir, "hold-at-exit.cjs");
    writeFileSync(
      hold,
      `const inject = ${JSON.stringify(inject)};
if (inject === "after-commit") {
  const log = console.log;
  console.log = (...args) => {
    if (String(args[0]).startsWith("\\nRestore complete.")) throw new Error("injected after commit");
    log(...args);
  };
} else if (inject === "at-apply") {
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    if (command === "pg_restore" && args.includes("--file=-")) throw new Error("injected at apply");
    return spawn(command, args, ...rest);
  };
  require("node:module").syncBuiltinESMExports();
}
process.once("beforeExit", () => {
  require("node:fs").writeFileSync(${JSON.stringify(held)}, "held");
  setTimeout(() => {}, 5000);
});
`,
    );
    const child = spawn(
      process.execPath,
      ["--require", hold, restore, f.archive, "--confirm", "RESTORE:restore_fixture"],
      { env: f.env(mode), stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
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
      while (!existsSync(held) && Date.now() < deadline) await delay(50);
      assert.ok(existsSync(held), `the restore never reached its exit:\n${output}`);
      child.kill(signal);
      const code = await Promise.race([
        closed,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), 15_000);
        }),
      ]);
      const label = `${mode}${inject ? ` + ${inject}` : ""} + ${signal}`;
      assert.equal(code, status, `${label}:\n${output}`);
      assert.match(output, reported, label);
      assert.doesNotMatch(output, /Restore completed|interrupted by|REFUSED/, label);
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
});
