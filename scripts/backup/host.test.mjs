import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
if (args[0] === 'info') process.exit(0);
if (args[0] === 'ps') {
  const scoped = args.includes('label=com.docker.compose.project=' + project);
  const svc = args.find(s => s.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);
  if (!scoped) out(project + '\\nknowledge-base-prod');
  else if (svc === 'app') out('app-id');
  else if (svc === 'postgres') out('pg-id');
  else out('app-id\\npg-id');
} else if (args[0] === 'network' && args[1] === 'inspect') {
  const info = fixture.networks[args.at(-1)];
  if (!info) process.exit(1);
  out(info.internal + '|' + info.project + (args[3].includes('compose.network') ? '|' + (info.name || args.at(-1)) : ''));
} else if (args[0] === 'inspect') {
  const template = args[2];
  const id = args.at(-1);
  if (!['app-id','pg-id'].includes(id)) process.exit(1);
  if (template.includes('Config.Labels')) out(template.includes('compose.service') ? (id === 'app-id' ? 'app' : 'postgres') : project);
  else if (template.includes('.Image')) out('image-id');
  else if (template.includes('.Mounts')) out('backups-volume');
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
} else if (args[0] === 'run') {
  const names = process.env.FIXTURE_NAMES.split('\\n').sort();
  fs.writeFileSync(process.env.RESULT, JSON.stringify({args, names}));
} else process.exit(3);
`;

function run(fixture = base) {
  const dir = mkdtempSync(join(tmpdir(), "backup-host-test-"));
  try {
    writeFileSync(join(dir, "docker.cjs"), dockerStub);
    writeFileSync(
      join(dir, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = run ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = --env-file ]; then
      FIXTURE_NAMES="$(cut -d= -f1 "$arg" | sort)"
      export FIXTURE_NAMES
      break
    fi
    previous="$arg"
  done
fi
exec ${process.execPath} "$FIXTURE_SCRIPT" "$@"
`,
    );
    chmodSync(join(dir, "docker"), 0o755);
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
    const result = spawnSync("bash", [host, "list", "--project", project], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        FIXTURE: join(dir, "fixture.json"),
        RESULT: join(dir, "result.json"),
        FIXTURE_SCRIPT: join(dir, "docker.cjs"),
      },
    });
    let invocation = null;
    try {
      invocation = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    } catch {}
    return { ...result, invocation };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
