// Dispatch and stop-signal tests for scripts/docker-entrypoint.sh, without app
// dependencies, a database, or Docker. Only the absolute image paths
// (/app/scripts/...) are remapped into a temporary fixture; the shell logic is
// the real script, run by the same /bin/sh the image uses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const basePath = `${dirname(process.execPath)}:/usr/bin:/bin`;
// The entrypoint repeats a stop's TERM only where /proc exists (have_proc);
// without it each signal sends one TERM, by design, since the image always
// has /proc. Tests of the repeat path therefore skip on hosts without /proc
// (macOS). ENTRYPOINT_TEST_ASSUME_NO_PROC=1, read only here, simulates such a
// host on Linux: those tests skip and every fixture entrypoint runs with its
// /proc detection removed, so the rest exercise the no-/proc fallback.
const procDetection = "if [ -r /proc/self/stat ]; then have_proc=true; fi";
const assumeNoProc = process.env.ENTRYPOINT_TEST_ASSUME_NO_PROC === "1";
const needsProc =
  !assumeNoProc && existsSync("/proc/self/stat")
    ? {}
    : { skip: "needs /proc (Linux); the image always has it" };
/** `test` for the /proc repeat path: skipped (with that reason) without /proc. */
const procTest = (name, fn) => test(name, needsProc, fn);
const serverEnv = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
  BETTER_AUTH_SECRET: "fixture-only",
};

async function entrypointFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-context-entrypoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  // `node -p` (the instance id) is real node; every other node call is the
  // recording stub below.
  await writeFile(
    join(dir, "bin", "node"),
    `#!/bin/sh
if [ "$1" = -p ]; then exec '${process.execPath}' "$@"; fi
exec '${process.execPath}' '${join(dir, "command.cjs")}' "$@"
`,
    { mode: 0o755 },
  );
  // tini stub: marks what it starts, then execs it.
  await writeFile(
    join(dir, "bin", "tini"),
    `#!/bin/sh
[ "$1" = -- ] && shift
FIXTURE_TINI=1 exec "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "command.cjs"),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + '\\n');
log({args, id: process.env.COCKPIT_CONTEXT_INSTANCE_ID ?? null, writer: Boolean(process.env.BACKUP_S3_SECRET_ACCESS_KEY || process.env.BACKUP_S3_ACCESS_KEY_ID), bucket: process.env.BACKUP_S3_BUCKET ?? null, tini: Boolean(process.env.FIXTURE_TINI)});
const notice = args.includes('--startup-notice');
if (notice && process.env.FIXTURE_NOTICE_FAIL) process.exit(1);
if (notice && process.env.FIXTURE_NOTICE_HANG) {
  // A stalled /backups mount: the check never finishes on its own.
  process.on('SIGTERM', () => { log({noticeTerm: true}); process.exit(143); });
  process.on('SIGINT', () => { log({noticeInt: true}); process.exit(130); });
  setInterval(() => {}, 1000);
  console.log('notice-started');
}
if (process.env.FIXTURE_REFUSE && args.includes('apply')) process.exit(7);
if (process.env.FIXTURE_HOLD && args.includes('apply')) {
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => setTimeout(() => {
    log({drained: true});
    clearInterval(timer);
  }, 60));
  setTimeout(() => { clearInterval(timer); process.exitCode = 99; }, 3000).unref();
  console.log('admission-started');
}
`,
  );
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const script = join(dir, "entrypoint.sh");
  let fixtureSource = source.replaceAll("/app/scripts/", `${dir}/scripts/`);
  if (assumeNoProc) {
    assert.ok(fixtureSource.includes(procDetection), "the /proc detection line exists");
    fixtureSource = fixtureSource.replace(procDetection, "");
  }
  await writeFile(script, fixtureSource);
  await mkdir(join(dir, "scripts/backup"), { recursive: true });
  for (const name of ["restore.sh", "pre-migrate.sh"])
    await writeFile(
      join(dir, "scripts/backup", name),
      `#!/bin/sh\nexec node '${dir}/scripts/backup/${name}' "$@"\n`,
    );
  /**
   * @param {string[]} args
   * @param {Record<string, string>} env
   * @param {{ signalOn?: string, signal?: NodeJS.Signals, script?: string, timeoutMs?: number, onSpawn?: (child: import("node:child_process").ChildProcess) => void }} [stop]
   *   send `signal` to the entrypoint once its output contains `signalOn`;
   *   `script` runs a modified copy instead of the entrypoint; `onSpawn` gets
   *   the entrypoint's ChildProcess
   */
  const run = async (args, env = {}, stop = {}) => {
    const log = join(dir, "commands");
    await writeFile(log, "");
    const child = spawn("sh", [stop.script ?? script, ...args], {
      env: { PATH: `${dir}/bin:${basePath}`, FIXTURE_LOG: log, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a hung run is reaped with every fixture child.
      detached: true,
    });
    stop.onSpawn?.(child);
    // The entrypoint's own exit; `close` also waits for every process that
    // still holds its output pipes.
    const exited = new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolveCode(exitCode ?? exitSignal));
    });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let output = "";
    let sent = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (stop.signalOn && !sent && output.includes(stop.signalOn)) {
        sent = true;
        child.kill(stop.signal ?? "SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let code;
    try {
      // Bounded: a regression that ignores a stop signal fails instead of hanging.
      code = await Promise.race([
        exited,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), stop.timeoutMs ?? 15_000);
        }),
      ]);
      assert.notEqual(code, "timeout", `the entrypoint did not exit in time:\n${output}`);
      // The entrypoint has exited: it must not have left a child running (a
      // stop that never reached the child). Allow 1 s for exits already under
      // way, then fail; the group is reaped either way.
      let survivors = true;
      for (let attempt = 0; attempt < 10 && survivors; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        try {
          process.kill(-child.pid, 0);
        } catch {
          survivors = false;
        }
      }
      assert.equal(
        survivors,
        false,
        `processes left running after the entrypoint exited:\n${output}`,
      );
    } finally {
      clearTimeout(timer);
      // Reap the whole group, even after a clean exit: a fixture child left
      // behind would hold the pipes and hang the suite.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone (ESRCH).
      }
      await exited.catch(() => {});
      await closed;
    }
    const lines = (await readFile(log, "utf8")).trim();
    const all = lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
    const isNotice = (entry) => entry.args?.includes("--startup-notice");
    return {
      code,
      output,
      all,
      commands: all.filter((entry) => entry.args && !isNotice(entry)),
      notices: all.filter(isNotice),
    };
  };
  return { dir, run };
}

test("all seven image commands dispatch before normal validation without registering an instance", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  for (const [args, expected] of [
    [["migrate"], ["db/migrate-runtime.mjs", "apply"]],
    [
      ["restore", "--list"],
      ["backup/restore.sh", "--list"],
    ],
    [
      ["backup", "--keep", "2"],
      ["backup/pre-migrate.sh", "--label", "manual", "--required", "--keep", "2"],
    ],
    [["backup-schedule"], ["backup/schedule.mjs", "run"]],
    [
      ["restore-drill", "dump"],
      ["backup/drill.mjs", "dump"],
    ],
    [
      ["hold-deletions", "3"],
      ["db/migrate-runtime.mjs", "hold", "3"],
    ],
    [
      ["hold-deletions", "--clear"],
      ["db/migrate-runtime.mjs", "hold", "--clear"],
    ],
  ]) {
    const result = await run(args, {
      DATABASE_URL: serverEnv.DATABASE_URL,
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
      COCKPIT_CONTEXT_INSTANCE_ID: "inherited-server-id",
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 1, args.join(" "));
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/${expected[0]}`,
      ...expected.slice(1),
    ]);
    assert.equal(result.commands[0].id, null);
    assert.equal(result.commands[0].writer, true);
    // `migrate` runs the runner as PID 1's child; every other one-shot is
    // exec'd under tini.
    assert.equal(result.commands[0].tini, args[0] !== "migrate");
    assert.equal(result.notices.length, args[0] === "migrate" ? 1 : 0);
  }
});

test("server apply / wait precede the CMD (under tini), with a fresh id and the backup writer keys dropped", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  const env = {
    ...serverEnv,
    BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
    BACKUP_S3_ACCESS_KEY_ID: "fixture-only",
    BACKUP_S3_BUCKET: "fixture-bucket",
    COCKPIT_CONTEXT_INSTANCE_ID: "inherited-id",
  };
  const ids = new Set();
  for (const [migrateOnStart, mode] of [
    [undefined, "apply"],
    ["false", "wait"],
    ["true", "apply"],
  ]) {
    const result = await run(["node", "apps/server/dist/index.mjs"], {
      ...env,
      ...(migrateOnStart ? { MIGRATE_ON_START: migrateOnStart } : {}),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 2);
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/db/migrate-runtime.mjs`,
      mode,
      "--role",
      "server",
    ]);
    assert.deepEqual(result.commands[1].args, ["apps/server/dist/index.mjs"]);
    const id = result.commands[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notEqual(id, "inherited-id");
    assert.equal(result.commands[1].id, id);
    assert.equal(result.commands[0].writer, true);
    assert.equal(result.commands[0].tini, false, "the runner is PID 1's child, not tini's");
    // The writer keys go; the non-secret location stays for the freshness monitor.
    assert.equal(result.commands[1].writer, false);
    assert.equal(result.commands[1].bucket, "fixture-bucket");
    assert.equal(result.commands[1].tini, true);
    // Backups are off here: the check runs once (it only warns about the
    // unused bucket), for the migrating and the waiting server alike.
    assert.equal(result.notices.length, 1);
    ids.add(id);
  }
  assert.equal(ids.size, 3);
  // Backups on and only waiting: no destination needed, no check.
  const waiting = await run(["node", "apps/server/dist/index.mjs"], {
    ...serverEnv,
    BACKUP_ENABLED: "true",
    MIGRATE_ON_START: "false",
  });
  assert.equal(waiting.code, 0, waiting.output);
  assert.equal(waiting.notices.length, 0);
  assert.equal(waiting.commands.length, 2);
  const refused = await run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    FIXTURE_REFUSE: "1",
  });
  assert.equal(refused.code, 7);
  assert.equal(refused.commands.length, 1, "a refused migration never starts the CMD");
});

test("BACKUP_ENABLED is strict, and a failing startup check stops the start", async (t) => {
  const { run } = await entrypointFixture(t);
  for (const args of [["migrate"], ["backup"], ["node", "apps/server/dist/index.mjs"]]) {
    const bad = await run(args, { ...serverEnv, BACKUP_ENABLED: "yes" });
    assert.equal(bad.code, 1);
    assert.match(bad.output, /BACKUP_ENABLED must be true or false/);
    assert.equal(bad.all.length, 0);
  }
  for (const args of [["migrate"], ["node", "apps/server/dist/index.mjs"]]) {
    const result = await run(args, {
      ...serverEnv,
      BACKUP_ENABLED: "true",
      FIXTURE_NOTICE_FAIL: "1",
    });
    assert.equal(result.code, 1, result.output);
    assert.equal(result.notices.length, 1);
    assert.equal(result.commands.length, 0);
  }
});

test("a monitor key that is the dump-writer key refuses the server start before anything runs", async (t) => {
  const { run } = await entrypointFixture(t);
  const reused = {
    ...serverEnv,
    BACKUP_S3_ACCESS_KEY_ID: "fixture-writer-key",
    BACKUP_S3_SECRET_ACCESS_KEY: "fixture-writer-secret",
    BACKUP_MONITOR_S3_ACCESS_KEY_ID: "fixture-writer-key",
    BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "fixture-writer-secret",
  };
  for (const MIGRATE_ON_START of ["true", "false"]) {
    const bad = await run(["node", "apps/server/dist/index.mjs"], { ...reused, MIGRATE_ON_START });
    assert.equal(bad.code, 1, bad.output);
    assert.match(bad.output, /BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID/);
    assert.equal(bad.all.length, 0);
  }
  // A distinct monitor key starts normally.
  const ok = await run(["node", "apps/server/dist/index.mjs"], {
    ...reused,
    BACKUP_MONITOR_S3_ACCESS_KEY_ID: "fixture-monitor-key",
  });
  assert.equal(ok.code, 0, ok.output);
});

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  test(`${signal} during a hanging startup check exits ${status}; the check gets TERM; the runner and CMD never start`, async (t) => {
    const { run } = await entrypointFixture(t);
    for (const args of [["migrate"], ["node", "apps/server/dist/index.mjs"]]) {
      const result = await run(
        args,
        { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
        { signalOn: "notice-started", signal },
      );
      assert.equal(result.code, status, result.output);
      assert.equal(result.notices.length, 1);
      // TERM for every stop signal: a background child of sh starts with
      // SIGINT ignored, so only TERM reliably stops it.
      assert.ok(
        result.all.some((entry) => entry.noticeTerm),
        `the check got TERM: ${JSON.stringify(result.all)}`,
      );
      assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
    }
  });
}

test("TERM during migrations is forwarded, PID 1 waits for the runner to drain, then exits 143", async (t) => {
  const { run } = await entrypointFixture(t);
  const result = await run(
    ["node", "apps/server/dist/index.mjs"],
    { ...serverEnv, FIXTURE_HOLD: "1" },
    { signalOn: "admission-started", signal: "SIGTERM" },
  );
  assert.equal(result.code, 143, result.output);
  assert.equal(result.commands.length, 1, "the CMD never starts");
  assert.ok(result.all.some((entry) => entry.drained));
});

test("stop-signal traps (TERM/INT/HUP) are installed before validation and any child, and cover the fork", async () => {
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const body = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const traps = [
    "trap 'stop_startup TERM 143' TERM",
    "trap 'stop_startup INT 130' INT",
    "trap 'stop_startup HUP 129' HUP",
  ].map((line) => body.indexOf(line));
  assert.ok(
    traps.every((index) => index > 0),
    "the TERM, INT and HUP traps exist, each keeping its own status",
  );
  const trap = Math.max(...traps);
  // The strict-switch validation and every child come after all three traps.
  for (const step of [
    "BACKUP_ENABLED must be true or false",
    "$(node",
    "supervise node",
    "supervise bash",
    "exec tini",
  ]) {
    const first = body.indexOf(step);
    assert.ok(first > trap, `${step} comes after the traps`);
  }
  // A signal between the fork and the PID assignment is only recorded (the
  // trap does not exit while a child is being launched); afterwards the child
  // is identified by its start time and gets TERM until it is gone.
  assert.match(
    body,
    /stop_startup\(\) \{\n\s*stop_signal="\$1"\n\s*\[ "\$stopping" = false \] \|\| \[ "\$have_proc" = false \] \|\| return 0\n\s*if \[ -n "\$child_pid" \]; then\n\s*stopping=true\n\s*stop_child\n\s*elif \[ "\$launching_child" = false \]; then\n\s*exit "\$2"\n\s*fi\n\s*\}/,
    "stop_startup only records a signal that lands while a child is launched",
  );
  assert.match(
    body,
    /launching_child=true\n\s*"\$@" &\n\s*child_pid=\$!\n\s*if \[ "\$have_proc" = true \]; then\n\s*proc_start "\$child_pid"\n\s*child_start=\$proc_start_value\n\s*fi\n\s*launching_child=false\n/,
    "supervise records the child's identity before it acts on a pending signal",
  );
  assert.match(
    body,
    /if \[ -n "\$stop_signal" \]; then\n\s*stopping=true\n\s*stop_child\n\s*wait "\$child_pid"/,
    "a pending or interrupting stop signal is forwarded until the child is gone",
  );
  // The trap path (stop_startup -> term_child -> child_alive -> proc_start)
  // never forks: no command substitution or external command in it.
  const fnBody = (name) => body.match(new RegExp(`\\n${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
  for (const name of ["stop_startup", "term_child", "child_alive", "proc_start"]) {
    const fn = fnBody(name);
    assert.ok(fn, `${name} exists`);
    assert.doesNotMatch(fn, /\$\(|`|\bcat\b|\bsleep\b/, `${name} never forks`);
  }
  // No step resets the handlers to the default (which PID 1 ignores).
  assert.doesNotMatch(body, /trap -( |$)/m);
});

// Copies of the entrypoint with a stop signal injected at the exact gap,
// without production hooks.
async function entrypointCopy(dir, name, edit) {
  const source = await readFile(join(dir, "entrypoint.sh"), "utf8");
  const lines = source.split("\n");
  const out = edit(lines);
  assert.notDeepEqual(out, lines, `${name}: the injection point was not found`);
  const path = join(dir, name);
  await writeFile(path, out.join("\n"));
  return path;
}
const injectBefore = (lines, target, injected) =>
  lines.flatMap((line) => (line.trim() === target ? [injected, line] : [line]));

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  const name = signal.slice(3);
  // Every test in this loop needs the /proc repeat path.
  const test = procTest;
  test(`${signal} in the fork window (after the fork, before the PID is known) still stops a hanging startup check; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    const script = await entrypointCopy(dir, `launch-gap-${name}.sh`, (lines) =>
      injectBefore(lines, "child_pid=$!", `  kill -${name} "$$"`),
    );
    // The TERM reaches the child within microseconds of its fork, where the
    // forked shell can still swallow it with the trap it inherited: a single
    // TERM was lost in about 40% of runs here. Repeat the case.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await run(
        ["node", "apps/server/dist/index.mjs"],
        { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
        { script, timeoutMs: 8_000 },
      );
      assert.equal(result.code, status, `attempt ${attempt}: ${result.output}`);
      assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
    }
  });

  test(`${signal}: a child that misses the first TERM is still stopped (the TERM is repeated until it is gone); exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The child swallows the first TERM it gets (then execs the command),
    // standing in for a TERM swallowed by the forked shell's inherited trap.
    // The stop is sent only once its trap is in place, so the first TERM is
    // always missed, however the processes are scheduled.
    const ready = join(dir, `deaf-ready-${name}`);
    const script = await entrypointCopy(dir, `deaf-child-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        "child_pid=$!",
        `  while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    assert.match(
      await readFile(script, "utf8"),
      /trap 'n=\$\(\(n \+ 1\)\)' TERM; : > '[^']+'; while \[ "\$n" -lt 1 \]/,
    );
    const result = await run(
      ["node", "apps/server/dist/index.mjs"],
      { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
      { script, timeoutMs: 8_000 },
    );
    assert.equal(result.code, status, result.output);
    assert.ok(result.notices.length <= 1);
    assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
  });

  test(`${signal} just before supervise's wait still stops a child that misses the first TERM; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The signal lands after the "no stop pending" check, right before
    // `wait`: the handler runs first, then `wait` blocks. The handler must
    // itself repeat the TERM, or the deaf child runs to its end.
    const ready = join(dir, `wait-gap-ready-${name}`);
    const script = await entrypointCopy(dir, `wait-gap-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        'wait "$child_pid"',
        `    while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    const result = await run(
      ["node", "apps/server/dist/index.mjs"],
      { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
      {
        script,
        timeoutMs: 8_000,
      },
    );
    assert.equal(result.code, status, result.output);
    assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
  });
}

procTest(
  "repeated stop signals while the handler drains a child do not delay the exit; the last one sets the status",
  async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // TERM arrives while supervise waits (as from `docker stop`); the handler
    // then repeats TERM until the child, which swallows the first three, is gone; HUPs
    // arrive during that drain. Each nested trap must only record itself, and
    // must not stretch the 0.2 s pause: in dash a nested trap leaves $? at the
    // outer trap's status (here the interrupted wait's), so the pause cannot
    // branch on sleep's status.
    // (The /proc repeat path: without /proc nothing drains, and the test would
    // only check signal timing.)
    const ready = join(dir, "drain-ready");
    const script = await entrypointCopy(dir, "drain-repeat.sh", (lines) =>
      lines.map((line) =>
        line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 3 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line,
      ),
    );
    const exists = (path) =>
      readFile(path).then(
        () => true,
        () => false,
      );
    let first = 0;
    // Bounded, and stopped once the run is over (even a failed one).
    let over = false;
    /** @type {Promise<void> | undefined} */
    let sender;
    let result;
    try {
      result = await run(
        ["node", "apps/server/dist/index.mjs"],
        { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
        {
          script,
          timeoutMs: 8_000,
          onSpawn: (child) => {
            sender = (async () => {
              const deadline = Date.now() + 8_000;
              while (!over && !(await exists(ready))) {
                if (Date.now() > deadline) return;
                await delay(10);
              }
              if (over) return;
              // Let supervise reach its wait.
              await delay(50);
              first = Date.now();
              child.kill("SIGTERM");
              // One HUP inside each 0.2 s pause of the drain.
              for (let i = 0; i < 3; i++) {
                await delay(i === 0 ? 60 : 200);
                if (over) return;
                child.kill("SIGHUP");
              }
            })();
          },
        },
      );
    } finally {
      over = true;
      await sender;
    }
    const elapsed = Date.now() - first;
    assert.equal(result.code, 129, result.output);
    assert.ok(first > 0, "the child became ready");
    // About 0.6 s (three 0.2 s pauses); each stretched pause would add up to
    // 1 s (2.5 s or more in all).
    assert.ok(elapsed < 1_500, `the entrypoint took ${elapsed} ms after the first stop`);
  },
);

test("without /proc, every stop signal still sends one TERM: a later signal stops a child that swallowed the first", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  // /proc detection forced off (the fallback outside Linux): nothing repeats
  // the TERM, so the stop guard must not swallow a later signal's TERM. The
  // first TERM (recorded during the launch) is swallowed by the child; the
  // second stop signal must stop it.
  const ready = join(dir, "noproc-ready");
  const script = await entrypointCopy(dir, "noproc.sh", (lines) =>
    injectBefore(
      lines.map((line) => {
        if (line.trim() === procDetection) return "";
        return line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line;
      }),
      "child_pid=$!",
      `  while [ ! -e '${ready}' ]; do :; done; kill -TERM "$$"`,
    ),
  );
  assert.doesNotMatch(await readFile(script, "utf8"), /have_proc=true/);
  const exists = (path) =>
    readFile(path).then(
      () => true,
      () => false,
    );
  let over = false;
  /** @type {Promise<void> | undefined} */
  let sender;
  let result;
  try {
    result = await run(
      ["node", "apps/server/dist/index.mjs"],
      { ...serverEnv, BACKUP_ENABLED: "true", FIXTURE_NOTICE_HANG: "1" },
      {
        script,
        timeoutMs: 8_000,
        onSpawn: (child) => {
          sender = (async () => {
            const deadline = Date.now() + 8_000;
            while (!over && !(await exists(ready))) {
              if (Date.now() > deadline) return;
              await delay(10);
            }
            // The first TERM has been swallowed by now; then a second stop.
            await delay(300);
            if (!over) child.kill("SIGHUP");
          })();
        },
      },
    );
  } finally {
    over = true;
    await sender;
  }
  assert.equal(result.code, 129, result.output);
  assert.ok(result.notices.length <= 1);
});
