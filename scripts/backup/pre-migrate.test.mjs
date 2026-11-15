import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./pre-migrate.sh", import.meta.url));

function fixture({ mounted = true, dumpFails = false, args = [], env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "backup-hook-test-"));
  const backups = join(root, "backups");
  const bin = join(root, "bin");
  mkdirSync(backups);
  mkdirSync(bin);
  try {
    // Substitute only the volume path and source directory. Every external
    // database command is inert; this never connects to Postgres or Docker.
    const script = readFileSync(sourcePath, "utf8")
      .replace('LOCAL_DIR="/backups"', `LOCAL_DIR="${backups}"`)
      .replace('HERE="$(cd "$(dirname "$0")" && pwd)"', `HERE="${dirname(sourcePath)}"`);
    writeFileSync(join(root, "pre-migrate.sh"), script);
    for (const [name, body] of Object.entries({
      mountpoint: `#!/usr/bin/env bash\nexit ${mounted ? 0 : 1}\n`,
      psql: '#!/usr/bin/env bash\nprintf "180000\\n"\n',
      pg_dump: `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pg_dump (PostgreSQL) 18.6'); process.exit(0); }
if (${dumpFails}) process.exit(1);
if (process.env.PGHOSTADDR || process.env.PGSERVICE || process.env.PGHOST !== 'fixture-db' || process.env.PGDATABASE !== 'cockpit_context') process.exit(2);
if (args.includes('/data') || !args.includes('-Fc')) process.exit(3);
fs.writeFileSync(args[args.indexOf('-f') + 1], 'PGDMP-fixture-database-only');
`,
      pg_restore: `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '--list' || !fs.readFileSync(process.argv[3], 'utf8').startsWith('PGDMP')) process.exit(1);
`,
    })) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    const result = spawnSync("bash", [join(root, "pre-migrate.sh"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DATABASE_URL: "postgresql://fixture-db/cockpit_context",
        PGHOSTADDR: "wrong-db",
        PGSERVICE: "wrong-service",
        ...env,
      },
    });
    return { ...result, files: readdirSync(backups), source: script };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("hook writes a verified database-only dump, dropping inherited libpq redirection", () => {
  const result = fixture({ args: ["--label", "manual", "--required"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0], /^manual-\d{8}T\d{6}Z.dump$/);
  assert.match(result.stdout, /Verified/);
  assert.match(
    result.source,
    /one-time-key snapshot clones: recovering those needs a separate volume snapshot/,
  );
});

test("hook refuses a failed dump and never publishes its partial file", () => {
  const result = fixture({ dumpFails: true, args: ["--required"] });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.files, []);
});

test("an image-layer placeholder is not a backup destination; manual required mode refuses", () => {
  const optional = fixture({ mounted: false });
  assert.equal(optional.status, 0, optional.stderr);
  assert.match(optional.stderr, /No pre-migration backup was taken/);
  assert.deepEqual(optional.files, []);
  const required = fixture({ mounted: false, args: ["--required"] });
  assert.notEqual(required.status, 0);
  assert.match(required.stderr, /no backup destination/);
});

const S3 = {
  BACKUP_S3_BUCKET: "test-bucket",
  BACKUP_S3_ACCESS_KEY_ID: "test-backup-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "test-backup-secret",
  BACKUP_S3_ENDPOINT: "http://127.0.0.1:9",
};
const noSecrets = (result) =>
  assert.doesNotMatch(result.stdout + result.stderr, /test-backup-secret|test-backup-key/);

test("startup check, backups off (default): one notice, a warning instead when a destination is configured", () => {
  for (const enabled of [{}, { BACKUP_ENABLED: "" }, { BACKUP_ENABLED: "false" }]) {
    // The one backups-off line per start (the entrypoint runs this for the
    // server and for a `migrate` job alike; the server itself logs none).
    const none = fixture({ mounted: false, args: ["--startup-notice"], env: enabled });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, "");
    assert.equal(none.stderr.trim().split("\n").length, 1);
    assert.match(
      none.stderr,
      /^NOTICE: \[backup\] Backups are OFF \(BACKUP_ENABLED is not true\);[^\n]*BACKUP_ENABLED=true[^\n]*docs\/backup-restore\.md/,
    );
    assert.deepEqual(none.files, [], "the startup check never dumps");
    for (const configured of [
      { mounted: true, env: enabled },
      { mounted: false, env: { ...enabled, ...S3 } },
    ]) {
      const result = fixture({ ...configured, args: ["--startup-notice"] });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim().split("\n").length, 1);
      assert.match(
        result.stderr,
        /WARNING: \[backup\] A backup destination is configured but BACKUP_ENABLED is not true/,
      );
      assert.doesNotMatch(result.stderr, /NOTICE:/);
      assert.deepEqual(result.files, [], "the startup check never dumps");
      noSecrets(result);
    }
  }
});

test("startup check, BACKUP_ENABLED=true: no usable destination stops the start; a valid one passes", () => {
  const env = { BACKUP_ENABLED: "true" };
  const none = fixture({ mounted: false, args: ["--startup-notice"], env });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /BACKUP_ENABLED=true but no backup destination is configured/);
  const badS3 = fixture({
    mounted: false,
    args: ["--startup-notice"],
    env: { ...env, BACKUP_S3_BUCKET: "test-bucket" },
  });
  assert.equal(badS3.status, 1);
  assert.match(badS3.stderr, /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/);
  const s3 = fixture({ mounted: false, args: ["--startup-notice"], env: { ...env, ...S3 } });
  assert.equal(s3.status, 0, s3.stderr);
  assert.match(s3.stderr, /Backups are ON \(BACKUP_ENABLED=true\).*BACKUP_S3_BUCKET/);
  noSecrets(s3);
  const local = fixture({ mounted: true, args: ["--startup-notice"], env });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stderr, /Backups are ON \(BACKUP_ENABLED=true\).*backups\.$/m);
  for (const result of [none, badS3, s3, local]) assert.deepEqual(result.files, []);
});

test("BACKUP_ENABLED is parsed strictly by the hook", () => {
  for (const value of ["TRUE", "1", "yes", "on", " true"]) {
    for (const args of [["--startup-notice"], ["--required"], []]) {
      const result = fixture({ args, env: { BACKUP_ENABLED: value } });
      assert.equal(result.status, 1, `${value} ${args}`);
      assert.match(result.stderr, /BACKUP_ENABLED must be true or false/);
      assert.deepEqual(result.files, []);
    }
  }
});

test("explicit --required calls dump whatever BACKUP_ENABLED says, and refuse without a destination", () => {
  for (const enabled of [{}, { BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "true" }]) {
    const dumped = fixture({ args: ["--label", "manual", "--required"], env: enabled });
    assert.equal(dumped.status, 0, dumped.stderr);
    assert.equal(dumped.files.length, 1);
    const refused = fixture({ mounted: false, args: ["--required"], env: enabled });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /no backup destination/);
  }
});
