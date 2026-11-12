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

function fixture({ mounted = true, dumpFails = false, args = [] } = {}) {
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
