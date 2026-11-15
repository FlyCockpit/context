import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxOnlyTest } from "./linux-only.mjs";

// host.sh is Linux-only (the Dokploy server): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

const host = fileURLToPath(new URL("./host.sh", import.meta.url));
const project = "cockpit-context-prod";
const privateNetwork = `${project}_private`;
const base = {
  appNetworks: ["custom-proxy", "egress", privateNetwork],
  pgNetworks: [privateNetwork],
  networks: {
    [privateNetwork]: { internal: true, project },
    "custom-proxy": { internal: false, project: "proxy" },
    egress: { internal: false, project },
  },
  aliases: ["postgres", "cockpit-context-postgres"],
};

// Docker is an inert inspect fixture. No real Docker, database or credential IO.
const dockerStub = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const project = ${JSON.stringify(project)};
const out = (s) => process.stdout.write(s + '\\n');
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
const ids = { 'app-id': 'app', 'pg-id': 'postgres', 'backup-id': 'backup' };
if (args[0] === 'info') process.exit(0);
if (args[0] === 'ps') {
  const scoped = args.includes('label=com.docker.compose.project=' + project);
  const svc = args.find(s => s.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);
  if (!scoped) process.stdout.write(fixture.projects ?? project + '\\nknowledge-base-prod\\n');
  else if (svc === 'app') out('app-id');
  else if (svc === 'postgres') out('pg-id');
  else if (svc === 'backup') { if (fixture.backupIds !== '') out(fixture.backupIds ?? 'backup-id'); }
  else out('app-id\\npg-id\\nbackup-id');
} else if (args[0] === 'network' && args[1] === 'inspect') {
  const info = fixture.networks[args.at(-1)];
  if (!info) process.exit(1);
  out(info.internal + '|' + info.project + (args[3].includes('compose.network') ? '|' + (info.name || args.at(-1)) : ''));
} else if (args[0] === 'inspect') {
  const template = args[2];
  const id = args.at(-1);
  if (!ids[id]) process.exit(1);
  if (template.includes('working_dir')) out(fixture.workingDir ?? '<no value>');
  else if (template.includes('config_files')) out(fixture.configFiles ?? '<no value>');
  else if (template.includes('Config.Labels')) out(template.includes('compose.service') ? ids[id] : project);
  else if (template.includes('.State.Running')) out('true');
  else if (template.includes('.Image')) out('image-id');
  else if (template.includes('.Mounts')) out(fixture.volumes?.[id] ?? fixture.volume ?? 'backups-volume');
  else if (template.includes('.Config.Env')) out([
    'DATABASE_URL=' + 'postgresql://writer:fixture@' + (fixture.databaseHost || 'postgres') + ':5432/cockpit_context',
    'BACKUP_S3_BUCKET=fixture-bucket', 'BACKUP_S3_PREFIX=cockpit-context/prod/database',
    'BACKUP_S3_ACCESS_KEY_ID=fixture-writer', 'BACKUP_S3_SECRET_ACCESS_KEY=fixture-secret',
    'BACKUP_S3_REGION=auto', 'BACKUP_S3_ENDPOINT=https://s3.example.test',
    'BACKUP_S3_FORCE_PATH_STYLE=true', 'BACKUP_S3_SSE=AES256',
    'S3_ACCESS_KEY_ID=fixture-unrelated', 'BACKUP_MONITOR_S3_ACCESS_KEY_ID=fixture-monitor',
    'BACKUP_MONITOR_S3_SECRET_ACCESS_KEY=fixture-monitor-secret',
    'BETTER_AUTH_SECRET=fixture-auth', 'COCKPIT_CONTEXT_ENCRYPTION_KEYS=fixture-keyring',
    'BACKUP_S3_UNKNOWN=fixture-unknown', 'BACKUP_HEARTBEAT_URL=https://heartbeat.example.test/token'
  ].join('\\n'));
  else if (template.includes('.Aliases')) out(fixture.aliases.join('\\n'));
  else if (template.includes('.NetworkSettings.Networks')) out((id === 'app-id' ? fixture.appNetworks : fixture.pgNetworks).join('\\n'));
  else process.exit(2);
} else if (args[0] === 'image' && args[1] === 'inspect') {
  // The app container's image ID is gone after a no-change redeploy (fixture.imageGone).
  if (fixture.imageGone || args.at(-1) !== 'image-id') {
    console.error('Error response from daemon: No such image: ' + args.at(-1));
    process.exit(1);
  }
} else if (args[0] === 'run') {
  const names = process.env.FIXTURE_NAMES.split('\\n').sort();
  fs.writeFileSync(process.env.RESULT, JSON.stringify({args, names}));
  if (args.includes('restore') && args.includes('--guided')) process.exitCode = Number(fixture.restoreExit ?? 0);
} else if (args[0] === 'stop') {
  // Once: the first stop (after the stop prompt) is interrupted by a signal.
  const signalled = process.env.CALLS + '.signalled';
  if (fixture.stopSignal && !fs.existsSync(signalled)) {
    fs.writeFileSync(signalled, '');
    process.kill(process.ppid, fixture.stopSignal);
  }
  if (process.env.MARK) {
    fs.writeFileSync(process.env.MARK, '');
    // Give the reader time to leave before the shell's next write.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  process.exitCode = Number(fixture.stopExit ?? 0);
} else if (args[0] === 'start') {
} else process.exit(3);
`;

/**
 * Real host.sh functions (sourced, then `body`), inert Docker boundary on an
 * isolated PATH entry; only disposable fake credentials. Bounded: a hung run
 * is killed with SIGKILL (its traps may hold a SIGTERM pending).
 */
function run(
  fixture = base,
  { body = `main list --project ${project}`, input = "", markOnStop = false, gone = false } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "backup-host-test-"));
  try {
    writeFileSync(join(dir, "docker.cjs"), dockerStub);
    writeFileSync(
      join(dir, "docker"),
      `#!/usr/bin/env bash
FIXTURE_NAMES=""
if [ "$1" = run ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = --env-file ]; then
      FIXTURE_NAMES="$(cut -d= -f1 "$arg" | sort)"
      break
    fi
    previous="$arg"
  done
fi
export FIXTURE_NAMES
exec ${process.execPath} "$FIXTURE_SCRIPT" "$@"
`,
    );
    chmodSync(join(dir, "docker"), 0o755);
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
    // Node starts children with SIGPIPE ignored; a terminal shell has it at the
    // default (fatal), so restore that before bash starts (GNU env, Linux-only).
    const result = spawnSync(
      "env",
      ["--default-signal=PIPE", "bash", "-c", `source "$1"\n${body}`, "host-test", host],
      {
        encoding: "utf8",
        input,
        timeout: 20_000,
        killSignal: "SIGKILL",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          FIXTURE: join(dir, "fixture.json"),
          RESULT: join(dir, "result.json"),
          CALLS: join(dir, "calls.jsonl"),
          FIXTURE_SCRIPT: join(dir, "docker.cjs"),
          ...(markOnStop ? { MARK: join(dir, "stopped") } : {}),
          ...(gone ? { HOST_TEST_GONE: join(dir, "reader-gone") } : {}),
        },
      },
    );
    let invocation = null;
    try {
      invocation = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    } catch {}
    let calls = [];
    try {
      calls = readFileSync(join(dir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {}
    return { ...result, invocation, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const verbs = (result, keep = ["stop", "start", "run", "restart", "kill"]) =>
  result.calls.map((args) => args[0]).filter((verb) => keep.includes(verb));
const targets = (result, verb) =>
  result.calls.filter((args) => args[0] === verb).map((args) => args.at(-1));

test("host selects the exact project's private intersection regardless of network order", () => {
  for (const appNetworks of [base.appNetworks, [...base.appNetworks].reverse()]) {
    const result = run({ ...base, appNetworks });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.invocation.args[result.invocation.args.indexOf("--network") + 1],
      privateNetwork,
    );
  }
});

test("host uses only the selected project's labelled egress for S3", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const args = result.invocation.args;
  assert.deepEqual(
    args.flatMap((arg, i) => (arg === "--network" ? [args[i + 1]] : [])),
    [privateNetwork, "egress"],
  );
  for (const fixture of [
    { ...base, appNetworks: [privateNetwork, "custom-proxy"] },
    {
      ...base,
      networks: { ...base.networks, egress: { internal: false, project: "knowledge-base-prod" } },
    },
  ]) {
    const refused = run(fixture);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /exactly one egress/);
    assert.equal(refused.invocation, null);
  }
});

test("host forwards exactly database and writer transport settings", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.invocation.names,
    [
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_ENDPOINT",
      "BACKUP_S3_FORCE_PATH_STYLE",
      "BACKUP_S3_PREFIX",
      "BACKUP_S3_REGION",
      "BACKUP_S3_SECRET_ACCESS_KEY",
      "BACKUP_S3_SSE",
      "DATABASE_URL",
    ],
    result.stderr,
  );
});

test("host refuses missing, ambiguous, non-internal and sibling-owned private networks", () => {
  for (const fixture of [
    { ...base, pgNetworks: [] },
    {
      ...base,
      appNetworks: [...base.appNetworks, "second"],
      pgNetworks: [privateNetwork, "second"],
      networks: { ...base.networks, second: { internal: true, project } },
    },
    { ...base, networks: { ...base.networks, [privateNetwork]: { internal: false, project } } },
    {
      ...base,
      networks: {
        ...base.networks,
        [privateNetwork]: { internal: true, project: "knowledge-base-prod" },
      },
    },
  ]) {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one project-private internal network/);
    assert.equal(result.invocation, null);
  }
});

test("host refuses a URL targeting a sibling database even with a valid shared network", () => {
  const result = run({ ...base, databaseHost: "knowledge-base-postgres" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not target/);
  assert.equal(result.invocation, null);
});

test("host can be sourced without discovering or changing anything", () => {
  const result = run(base, { body: ":" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("host rejects an unknown command and an incomplete --project before Docker", () => {
  for (const [body, message] of [
    ["main unknown", /unknown command/],
    ["main list --project", /needs a name/],
  ]) {
    const result = run(base, { body });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls, []);
  }
});

test("host refuses Docker results missing compose project labels", () => {
  const result = run({ ...base, projects: "\n<no value>\n" }, { body: "main list" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no app found/);
  assert.equal(result.invocation, null);
});

test("host supports S3-only backups without a backups volume", () => {
  const result = run({ ...base, volume: "" }, { body: `main backup --project ${project}` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.invocation.args.includes("-v"));
});

test("host falls back to the backup scheduler's /backups volume when the app has none", () => {
  // compose.yaml without compose.backup.yaml: only the `backup` service mounts it.
  const result = run(
    { ...base, volumes: { "app-id": "", "backup-id": "scheduler-volume" } },
    { body: `main backup --project ${project}` },
  );
  assert.equal(result.status, 0, result.stderr);
  const args = result.invocation.args;
  assert.equal(args[args.indexOf("-v") + 1], "scheduler-volume:/backups");
  // The app's own volume still wins when it has one.
  const own = run(
    { ...base, volumes: { "app-id": "app-volume", "backup-id": "scheduler-volume" } },
    { body: `main backup --project ${project}` },
  );
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.invocation.args[own.invocation.args.indexOf("-v") + 1], "app-volume:/backups");
  // No scheduler: no volume (S3-only).
  const none = run(
    { ...base, volumes: { "app-id": "" }, backupIds: "" },
    { body: `main backup --project ${project}` },
  );
  assert.equal(none.status, 0, none.stderr);
  assert.ok(!none.invocation.args.includes("-v"));
  // Two schedulers are ambiguous: refuse before any one-off container.
  const two = run(
    { ...base, volumes: { "app-id": "" }, backupIds: "backup-id\nbackup-id" },
    { body: `main backup --project ${project}` },
  );
  assert.equal(two.status, 1);
  assert.match(two.stderr, /at most one backup container/);
  assert.equal(two.invocation, null);
});

// --- restore ----------------------------------------------------------------
const restoreBody = `require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project ${project}`;
const writerIds = ["app-id", "backup-id"];

test("host restarts the app and scheduler after a cancelled/refused (3) or rolled-back (4) restore", () => {
  for (const [restoreExit, message] of [
    [3, /Cancelled or refused; nothing was changed[\s\S]*Started the app again/],
    [
      4,
      /Restore failed and was rolled back; the database is unchanged[\s\S]*Started the app again/,
    ],
  ]) {
    const result = run({ ...base, restoreExit }, { body: restoreBody });
    assert.equal(result.status, restoreExit, result.stderr);
    // The restart waits for each writer's stop (idempotent) before starting
    // it: an interrupted `docker stop` would otherwise make the start a no-op
    // on a container that then exits (the stop-then-start race).
    assert.deepEqual(verbs(result), ["stop", "stop", "run", "stop", "start", "stop", "start"]);
    assert.deepEqual(targets(result, "start"), writerIds);
    const calls = result.calls.filter((args) => ["stop", "start"].includes(args[0]));
    assert.deepEqual(
      calls.slice(2).map((args) => `${args[0]} ${args.at(-1)}`),
      ["stop app-id", "start app-id", "stop backup-id", "start backup-id"],
    );
    assert.deepEqual(result.invocation.args.slice(-3), [
      "restore",
      "/backups/daily.dump",
      "--guided",
    ]);
    // Postgres is never stopped or started.
    assert.ok(
      !result.calls.some((args) => ["stop", "start"].includes(args[0]) && args.includes("pg-id")),
    );
    assert.match(result.stdout + result.stderr, message);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /outcome is uncertain, or|Restore done|stays stopped until/,
    );
    if (restoreExit !== 4) assert.doesNotMatch(result.stdout + result.stderr, /was rolled back/);
  }
});

test("host keeps the app and scheduler stopped after a completed (0) restore and prints the next steps", () => {
  const result = run({ ...base, restoreExit: 0 }, { body: restoreBody });
  assert.equal(result.status, 0, result.stderr);
  // Stopped for the restore, never started again: /data snapshot clones and
  // the keyring come first (docs/backup-restore.md, Offline restore step 5).
  assert.deepEqual(verbs(result), ["stop", "stop", "run"]);
  assert.deepEqual(targets(result, "stop"), writerIds);
  assert.deepEqual(targets(result, "start"), []);
  const output = result.stdout + result.stderr;
  // In order: snapshot clones, keyring, then the start command for exactly
  // the writers it stopped.
  assert.match(
    result.stderr,
    /Restore done\. The app stays stopped[\s\S]*1\. Recover any separately protected \/data snapshot clones[\s\S]*2\. Check the app is configured with the original COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring[\s\S]*3\. Start the app[\s\S]*docker start app-id backup-id[\s\S]*pnpm deploy:check/,
  );
  // The pre-stop notice says so too.
  assert.match(
    result.stdout,
    /After a restore that completed, or[\s\S]*?one whose outcome is uncertain, the app stays stopped/,
  );
  assert.doesNotMatch(output, /Started the app again|outcome is uncertain, or/);
});

test("host keeps the app stopped after a restore whose outcome is uncertain (or that committed, then failed)", () => {
  for (const restoreExit of [1, 2, 5, 7, 125, 129, 130, 143]) {
    const result = run({ ...base, restoreExit }, { body: restoreBody });
    assert.equal(result.status, restoreExit, result.stderr);
    assert.deepEqual(verbs(result), ["stop", "stop", "run"], String(restoreExit));
    const output = result.stdout + result.stderr;
    assert.match(
      output,
      new RegExp(
        `Restore failed and its outcome is uncertain, or it committed and a later step failed \\(exit ${restoreExit}\\): the restore output above says which\\. The app stays stopped`,
      ),
    );
    assert.match(output, /Inspect the database first \(bash \S+ list; the restore output above\)/);
    assert.match(output, /docker start app-id backup-id/);
    // It may have committed ("confirmed COMMIT, then failed", or a signal to
    // the helper during a restore that completed): the /data and keyring
    // steps come before the start command here too.
    assert.match(
      output,
      /\/data snapshot clones[\s\S]*COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring[\s\S]*docker start app-id backup-id/,
    );
    assert.doesNotMatch(output, /Started the app again|Restore done|was rolled back/);
    if (restoreExit === 125) assert.match(output, /docker run failed \(exit 125\)/);
  }
});

// The stop prompt's answer arrives on stdin here instead of /dev/tty; ask()'s
// own y/yes check, EOF handling and the cancel path are the real ones.
const answerFromStdin = 'read_answer() { read -r -p "$1 [y/N] " answer; }';
const promptRestore = `require_terminal() { return 0; }\n${answerFromStdin}\nmain restore daily.dump --project ${project}`;
const cancelLine = "[app-db] Cancelled. Nothing was changed; the app was not stopped.\n";

test("host restore: declining the stop prompt (n, Enter, other text, EOF) exits 3 with the app untouched", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["no", "no\n"],
    ["empty input", "\n"],
    ["other text", "sure\n"],
    ["EOF", ""],
  ]) {
    const result = run(base, { body: promptRestore, input });
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.deepEqual(verbs(result), [], label);
    // The cancel is the last word, and no EXIT-trap outcome note (stderr) follows.
    assert.ok(result.stdout.endsWith(cancelLine), `${label}: ${result.stdout}`);
    assert.doesNotMatch(result.stderr, /\[app-db\]/, label);
  }
});

test("host restore: only y / yes at the stop prompt stops the app", () => {
  for (const input of ["y\n", "Y\n", "yes\n", "YES\n"]) {
    const result = run(base, { body: promptRestore, input });
    assert.equal(result.status, 0, `${JSON.stringify(input)}: ${result.stderr}`);
    assert.deepEqual(verbs(result).slice(0, 3), ["stop", "stop", "run"], JSON.stringify(input));
  }
});

test("host restore: a declined stop prompt still exits 3 through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["EOF", ""],
  ]) {
    const result = run(base, {
      body: `${promptRestore.replace(/\nmain .*$/, "")}\nset -o pipefail\nmain restore daily.dump --project ${project} | cat\nexit $?`,
      input,
    });
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.match(result.stdout, /Cancelled\. Nothing was changed/, label);
    assert.deepEqual(verbs(result), [], label);
    const piped = run(base, {
      body: `${promptRestore.replace(/\nmain .*$/, "")}\nset +o pipefail\nmain restore daily.dump --project ${project} | cat\nexit "\${PIPESTATUS[0]}"`,
      input,
    });
    assert.equal(piped.status, 3, `${label} (PIPESTATUS): ${piped.stderr}`);
  }
});

// A reader that leaves after the banner and closes its end of the pipe.
const leavingReader = `| { while read -r line; do [[ "$line" != *"asked once more"* ]] || break; done; exec 0<&-; touch "$HOST_TEST_GONE"; }`;

test("host restore: a declined stop prompt exits 3 even when the `| tee` reader left while it waited", () => {
  const result = run(base, {
    body: `require_terminal() { return 0; }
read_answer() { until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; read -r answer; }
main restore daily.dump --project ${project} ${leavingReader}
exit "\${PIPESTATUS[0]}"`,
    input: "n\n",
    gone: true,
  });
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(verbs(result), []);
});

const promptSignals = [
  ["SIGINT", "INT"],
  ["SIGTERM", "TERM"],
  ["SIGHUP", "HUP"],
];
// The stop prompt waits on a reader that never answers and never reaches EOF
// while this shell lives (an EOF would cancel with 3 too, hiding an ignored
// signal: the run would time out instead). The signal reaches this shell (the
// pipeline's subshell under `| cat`) while `read` blocks.
const waitForever = 'read -r answer < <(exec tail -f /dev/null --pid="$pid" 2>/dev/null)';
const signalAtPrompt = (signal) =>
  `require_terminal() { return 0; }
read_answer() { local pid=$BASHPID; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }`;

test("host restore: Ctrl-C (INT), TERM or HUP while the stop prompt waits exits 3 with the app untouched", () => {
  for (const [name, signal] of promptSignals) {
    const result = run(base, {
      body: `${signalAtPrompt(signal)}\nmain restore daily.dump --project ${project}`,
    });
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(verbs(result), [], name);
    assert.ok(result.stdout.endsWith(cancelLine), `${name}: ${result.stdout}`);
    assert.doesNotMatch(result.stderr, /\[app-db\]/, name);
  }
});

test("host restore: a signal at the stop prompt still exits 3 through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [name, signal] of promptSignals) {
    for (const [mode, tail] of [
      ["pipefail", `set -o pipefail\nmain restore daily.dump --project ${project} | cat\nexit $?`],
      [
        "PIPESTATUS",
        `set +o pipefail\nmain restore daily.dump --project ${project} | cat\nexit "\${PIPESTATUS[0]}"`,
      ],
    ]) {
      const result = run(base, { body: `${signalAtPrompt(signal)}\n${tail}` });
      assert.equal(result.status, 3, `${name} (${mode}): ${result.stderr}`);
      assert.match(result.stdout, /Cancelled\. Nothing was changed/, `${name} (${mode})`);
      assert.deepEqual(verbs(result), [], `${name} (${mode})`);
    }
  }
});

test("host restore: a signal at the stop prompt exits 3 even when a `2>&1 | tee` reader is gone", () => {
  // The reader leaves after the banner; only then does the signal arrive, so
  // both the newline (stderr) and the cancel message (stdout) hit a broken pipe.
  for (const [name, signal] of promptSignals) {
    const result = run(base, {
      body: `require_terminal() { return 0; }
read_answer() { local pid=$BASHPID; until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }
main restore daily.dump --project ${project} 2>&1 ${leavingReader}
exit "\${PIPESTATUS[0]}"`,
      gone: true,
    });
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(verbs(result), [], name);
  }
});

test("host restore: the stop prompt's signal traps are gone after it (the previous ones are back)", () => {
  const result = run(base, {
    body: `${answerFromStdin}
trap 'echo previous-int' INT
trap - TERM
confirm_stop
trap -p INT TERM HUP`,
    input: "y\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "trap -- 'echo previous-int' SIGINT\n");
});

test("host restore: a signal after the stop prompt keeps its own handling (128+n, writers started again)", () => {
  for (const [name, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    const result = run({ ...base, stopSignal: name }, { body: promptRestore, input: "y\n" });
    assert.equal(result.status, status, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.ok(!verbs(result).includes("run"), name);
    const started = targets(result, "start");
    assert.ok(started.length > 0, name);
    assert.deepEqual(new Set(started), new Set(targets(result, "stop")), name);
    assert.match(result.stderr, /Restore was not invoked; nothing was changed/, name);
    assert.doesNotMatch(result.stdout, /the app was not stopped/, name);
  }
});

test("host restore refuses before stopping anything when stdin is not a terminal", () => {
  // spawnSync gives the script a pipe for stdin: the real require_terminal.
  const result = run(base, { body: `ask() { return 0; }\nmain restore --project ${project}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run it in a terminal/);
  assert.deepEqual(verbs(result), []);
});

test("host restore | tee: a terminal on stdin alone gets docker run -it", () => {
  // stdout is a pipe here (as with `| tee log`); stdin is reported as a terminal.
  const result = run(base, { body: `stdin_is_terminal() { return 0; }\n${restoreBody}` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.invocation.args.includes("-it"), result.invocation.args.join(" "));
  // Without one, no -it (list from a script or cron).
  const plain = run();
  assert.ok(!plain.invocation.args.includes("-it"));
});

test("host starts the app again when its stdout reader dies mid-restore (`restore | tee`, Ctrl-C)", () => {
  // The reader leaves once the first writer is stopped, like `tee` killed by
  // Ctrl-C; the next write ("Stopping backup ...") hits a broken pipe, before
  // the restore is invoked. That must end the shell through set -e (EXIT trap
  // runs), never through SIGPIPE (141, nothing started again).
  const result = run(base, {
    body: `${restoreBody} | { until [ -f "$MARK" ]; do read -r -t 0.05 _ || true; done; exec 0<&-; }
exit "\${PIPESTATUS[0]}"`,
    markOnStop: true,
  });
  assert.notEqual(result.status, 141, result.stderr);
  assert.deepEqual(targets(result, "start"), writerIds, result.stderr);
  assert.ok(!verbs(result).includes("run"));
  assert.match(result.stderr, /Restore was not invoked; nothing was changed/);
});

test("host restarts app writers even when stopping one fails", () => {
  const result = run(
    { ...base, stopExit: 8 },
    {
      body: `require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project ${project}`,
    },
  );
  assert.equal(result.status, 8, result.stderr);
  assert.deepEqual(targets(result, "start"), writerIds);
  assert.ok(!verbs(result).includes("run"));
});

test("host prints usage with no arguments, from a file and piped into bash -s, exit 2", () => {
  const file = spawnSync("bash", [host], { encoding: "utf8" });
  assert.equal(file.status, 2, file.stderr);
  assert.match(file.stdout, /restore/);
  assert.equal(file.stderr, "");
  const piped = spawnSync("bash", ["-s"], { input: readFileSync(host, "utf8"), encoding: "utf8" });
  assert.equal(piped.status, 2, piped.stderr);
  assert.match(piped.stderr, /^Usage: bash <this script> list \| backup \| restore/);
  assert.doesNotMatch(piped.stderr, /sed:|No such file/);
});

test("host stops with the recreate command when the app's image ID is gone, and never runs the tag", () => {
  const vps = "/srv/cc/compose.yaml,/srv/cc/compose.vps.yaml,/srv/my cc/compose.backup.yaml";
  for (const [command, workingDir, dir, configFiles, files] of [
    [
      "list",
      "/etc/dokploy/compose/cockpit-context-prod/code",
      "/etc/dokploy/compose/cockpit-context-prod/code",
      "/etc/dokploy/compose/cockpit-context-prod/code/docker-compose.yml",
      " -f /etc/dokploy/compose/cockpit-context-prod/code/docker-compose.yml",
    ],
    // printf %q quotes a real directory and file; overlays are kept in order.
    [
      "backup",
      "/srv/my app",
      "/srv/my\\ app",
      vps,
      " -f /srv/cc/compose.yaml -f /srv/cc/compose.vps.yaml -f /srv/my\\ cc/compose.backup.yaml",
    ],
    // Unknown labels: the placeholders are printed verbatim.
    [
      "drill",
      undefined,
      "<the compose's directory>",
      undefined,
      " -f <each compose file the deploy uses>",
    ],
    [
      "restore daily.dump",
      undefined,
      "<the compose's directory>",
      undefined,
      " -f <each compose file the deploy uses>",
    ],
  ]) {
    const result = run(
      {
        ...base,
        imageGone: true,
        ...(workingDir ? { workingDir } : {}),
        ...(configFiles ? { configFiles } : {}),
      },
      {
        body: `require_terminal() { return 0; }\nask() { return 0; }\nmain ${command} --project ${project}`,
      },
    );
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /the app container's image \(image-id\) is no longer on this machine/,
    );
    assert.ok(
      result.stderr.includes(
        `cd ${dir} && docker compose -p ${project}${files} up -d --no-build --force-recreate app`,
      ),
      `${command}: ${result.stderr}`,
    );
    assert.match(result.stderr, /--profile backup/);
    // Nothing was run, stopped or started: no fallback to the image's tag.
    assert.deepEqual(verbs(result), [], command);
  }
});
