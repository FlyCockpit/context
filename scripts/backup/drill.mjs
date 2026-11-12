#!/usr/bin/env node
/**
 * Image command `restore-drill <source>` — proves a backup restores.
 *
 * Restores <source> (`latest`, a /backups file, or s3://… with --etag and
 * optionally --version-id — the only options it accepts) into
 * DATABASE_URL, which must be a THROWAWAY EMPTY database: scripts/backup/host.sh
 * `drill` starts a temporary Postgres container for it and removes it after.
 * Production is never touched: the database must be named `restore_drill`,
 * and `restore` without --replace refuses any non-empty target.
 *
 * Then it checks the result:
 *   - every table the archive has data for exists in the restored database;
 *   - Prisma's history has applied migrations and none unfinished;
 * and prints each table's row count and the backup's age. Exit 0 = PASS.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgEnvFromUrl, pickLatest } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRILL_DATABASE = "restore_drill";

/**
 * Tables with a TABLE DATA entry in `pg_restore --list` output.
 * @param {string} listing
 * @returns {string[]} `schema.table`
 */
export function archiveTables(listing) {
  const tables = new Set();
  for (const line of listing.split("\n")) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line);
    if (match) tables.add(`${match[1]}.${match[2]}`);
  }
  return [...tables].sort();
}

/** `Archive created at` from `pg_restore --list` output, or null. */
export function archiveCreatedAt(listing) {
  // `2026-11-11 03:00:01 UTC`; the images run in UTC, so other zones (rare)
  // are read as UTC too: the age is only a hint.
  const match = /^;\s*Archive created at:?\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/im.exec(
    listing,
  );
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * @param {{ expected: string[], counts: Map<string, number>,
 *   migrations: { applied: number, unfinished: number } | null }} result
 * @returns {{ pass: boolean, problems: string[] }}
 */
export function drillVerdict({ expected, counts, migrations }) {
  const problems = [];
  const required = [
    "public._cockpit_context_migration",
    "public._cockpit_context_instance",
    "public._cockpit_context_hold",
  ];
  const missing = [...new Set([...expected, ...required])].filter((table) => !counts.has(table));
  if (missing.length) problems.push(`tables missing after the restore: ${missing.join(", ")}`);
  if (!migrations) problems.push("no _prisma_migrations table: this is not a backup of this app");
  else {
    if (migrations.applied < 1) problems.push("Prisma's history lists no applied migration");
    if (migrations.unfinished > 0)
      problems.push(`${migrations.unfinished} unfinished (failed) migration(s) in the history`);
  }
  return { pass: problems.length === 0, problems };
}

/** @param {NodeJS.ProcessEnv} env @param {string} sql */
function psql(env, sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

const DRILL_USAGE =
  "usage: restore-drill <latest | /backups/<file> | s3://bucket/key --etag <etag> [--version-id <id>]>";

/**
 * The drill's arguments: one source plus, for s3:// only, the options that pin
 * the exact object. Anything else is refused: the drill confirms the restore
 * itself, so it must never pass through an option that widens it (--replace,
 * --allow-active-connections, --skip-snapshot, --confirm, …).
 * @param {readonly string[]} argv
 * @returns {{ source: string, pins: string[] }}
 */
export function parseDrillArgs(argv) {
  const [source, ...rest] = argv;
  if (!source || source.startsWith("-")) throw new Error(DRILL_USAGE);
  /** @type {Map<string, string>} */
  const pins = new Map();
  while (rest.length) {
    const arg = /** @type {string} */ (rest.shift());
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== "--etag" && flag !== "--version-id")
      throw new Error(`restore-drill does not accept ${arg}.\n${DRILL_USAGE}`);
    const value = eq === -1 ? rest.shift() : arg.slice(eq + 1);
    if (!value || value.startsWith("-") || pins.has(flag))
      throw new Error(`${flag} needs one value.\n${DRILL_USAGE}`);
    pins.set(flag, value);
  }
  if (pins.size && !source.startsWith("s3://"))
    throw new Error(`--etag and --version-id apply only to s3:// sources.\n${DRILL_USAGE}`);
  return { source, pins: [...pins].flat() };
}

const ident = (name) => `"${name.replaceAll('"', '""')}"`;

async function main(argv) {
  let source;
  let pins;
  try {
    ({ source, pins } = parseDrillArgs(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const pgEnv = pgEnvFromUrl(process.env.DATABASE_URL);
  if (pgEnv.PGDATABASE !== DRILL_DATABASE) {
    console.error(
      `REFUSED: the drill restores only into a throwaway database named "${DRILL_DATABASE}" (DATABASE_URL names "${pgEnv.PGDATABASE}"). Run it with host.sh drill.`,
    );
    return 1;
  }
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PG"))),
    ...pgEnv,
    PGCONNECT_TIMEOUT: "10",
  };

  console.log(`== Restore drill: ${source} → throwaway database "${DRILL_DATABASE}" ==`);
  const restoreArgs = [
    path.join(HERE, "restore.mjs"),
    source,
    ...pins,
    "--confirm",
    `RESTORE:${DRILL_DATABASE}`,
  ];
  const code = await new Promise((resolve) => {
    // RESTORE_DRILL=1: restore skips its production "Next steps" (start the app, …).
    const child = spawn(process.execPath, restoreArgs, {
      env: { ...process.env, RESTORE_DRILL: "1" },
      stdio: "inherit",
    });
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    console.log("\nDRILL FAILED: the restore itself failed (see above).");
    return 1;
  }

  const counts = new Map();
  for (const row of psql(
    env,
    "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY 1",
  )
    .split("\n")
    .filter(Boolean)) {
    const [schema, table] = row.split(/\.(.*)/s);
    counts.set(row, Number(psql(env, `SELECT count(*) FROM ${ident(schema)}.${ident(table)}`)));
  }
  // The tables the archive has data for (local raw archives; a gzip-wrapped
  // or S3 source skips this comparison).
  let expected = [];
  let createdAt = null;
  const archivePath = source.startsWith("s3://") ? null : resolveLocal(source);
  if (archivePath) {
    const listing = spawnSync("pg_restore", ["--list", archivePath], { env, encoding: "utf8" });
    if (listing.status === 0) {
      expected = archiveTables(listing.stdout);
      createdAt = archiveCreatedAt(listing.stdout);
    }
  }
  const hasHistory =
    psql(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL") === "t";
  const migrations = hasHistory
    ? (() => {
        const [applied, unfinished] = psql(
          env,
          "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM public._prisma_migrations",
        ).split("\t");
        return { applied: Number(applied), unfinished: Number(unfinished) };
      })()
    : null;

  console.log("\nRows per table in the restored copy:");
  for (const [table, rows] of counts) console.log(`  ${table.padEnd(48)} ${rows}`);
  if (migrations)
    console.log(`Applied migrations: ${migrations.applied} (unfinished: ${migrations.unfinished})`);
  if (createdAt !== null) {
    const hours = Math.round((Date.now() - createdAt) / 3_600_000);
    console.log(`Backup age: about ${hours} hour(s)`);
    if (hours > 26)
      console.log(
        "WARNING: the newest backup is more than a day old. Check that scheduled backups are running.",
      );
  }
  const verdict = drillVerdict({ expected, counts, migrations });
  if (verdict.pass) {
    console.log(
      "\nDRILL PASSED: the backup restores and holds this app's data. Record the date, the backup and this result in your deployment recovery log.",
    );
    return 0;
  }
  console.log(`\nDRILL FAILED:\n  - ${verdict.problems.join("\n  - ")}`);
  return 1;
}

/** The local file `restore` read for <source> (the same pick for `latest`). */
function resolveLocal(source) {
  if (source !== "latest") return path.resolve(source);
  try {
    const entries = readdirSync("/backups").map((name) => {
      const info = statSync(path.join("/backups", name));
      return { name, mtimeMs: info.mtimeMs, size: info.isFile() ? info.size : -1 };
    });
    const latest = pickLatest(entries.filter((entry) => entry.size >= 0));
    return latest ? path.join("/backups", latest) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
