#!/usr/bin/env node
/**
 * The single database restore command. Runs INSIDE the target network as the
 * app image's `restore` command (a one-shot ACA job / ECS task, or a one-off
 * container on the Dokploy host) — never from a developer machine.
 *
 *   restore <source> [--confirm RESTORE:<target-database>] [--replace] [...]
 *
 * See RESTORE_USAGE in lib.mjs for every option. The target is DATABASE_URL.
 *
 * Safeguards, in order (nothing changes before step 6):
 *   1. Source: local file or s3:// object pinned by --etag (and --version-id);
 *      gzip wrappers (Dokploy) are unwrapped; the archive must be pg_dump
 *      custom or tar format and must read completely with pg_restore.
 *   2. Target: reachable, primary (not a read replica), pg_restore client major
 *      ≥ server major; empty unless --replace.
 *   3. Confirmation: --confirm must equal RESTORE:<database named in DATABASE_URL>.
 *      Without it this command only prints a preview.
 *   4. Locks: a dedicated restore advisory lock (no concurrent restore),
 *      Prisma Migrate's own advisory lock, and the migration runner's lock
 *      (scripts/db/migrate-runtime.mjs apply), held for the whole restore, so no
 *      migration or migration runner can work meanwhile. The target is
 *      re-inspected under the locks; a recorded unfinished migration is reported.
 *   5. Writers: refuses while other sessions are connected (stop the app and backup scheduler
 *      first) unless --allow-active-connections.
 *   6. Snapshot: a non-empty target is dumped first (pre-migrate.sh --label
 *      pre-restore --required → /backups and/or S3) unless --skip-snapshot.
 *   7. Restore: schema drop (replace only) + the whole archive run in ONE
 *      transaction; any error rolls everything back and leaves the target as it was.
 *      The same transaction holds scheduled deletions for 7 days (a `restore`
 *      row in `_cockpit_context_hold`, scripts/db/lib/contracts.mjs) when the restored
 *      database has Prisma history, so a deletion the dump predates is not
 *      re-run while the restored data is checked or recovered.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdtemp, open, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { HOLD_DDL } from "../db/lib/contracts.mjs";
import { prismaSchemaName } from "../db/lib/migration-state.mjs";
import {
  detectArchiveFormat,
  expectedConfirmation,
  guidedAnswerConfirms,
  guidedQuestion,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_MIGRATE_LOCK_KEY,
  parseRestoreArgs,
  parseS3Source,
  pgEnvFromUrl,
  pickLatest,
  RESTORE_LOCK_KEY,
  RESTORE_USAGE,
  shellQuote,
  sortBackups,
  UsageError,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = "/backups";
const LOCK_APP_NAME = "cockpit-context-restore-lock";

class Refusal extends Error {}

/** @type {Set<import("node:child_process").ChildProcess>} */
const children = new Set();

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, capture?: boolean }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(command, args, { env, capture = true }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      children.delete(child);
      resolvePromise({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

/**
 * One read-only query with short timeouts; returns trimmed unaligned output.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} sql
 */
async function query(env, sql) {
  const result = await run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: { ...env, PGOPTIONS: "-c lock_timeout=5s -c statement_timeout=60s" },
  });
  if (result.code !== 0) {
    throw new Refusal(
      `database query failed: ${result.stderr.trim() || `psql exited ${result.code}`}`,
    );
  }
  return result.stdout.trim();
}

/** @param {string} path */
async function readHead(path) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, 512, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** @param {string} path */
async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Resolve the source to a verified local pg_dump archive.
 * @param {import("./lib.mjs").RestoreArgs} args
 * @param {string} workDir
 */
async function prepareSource(args, workDir) {
  /** @type {string[]} */
  const identity = [];
  let path;
  const s3Location = parseS3Source(args.source);
  if (s3Location) {
    const s3 = await import("./s3.mjs");
    let config;
    try {
      config = s3.backupS3Config();
    } catch (error) {
      throw new Refusal(
        `S3 source needs the backup bucket settings: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
    const head = await s3.describeObject({
      location: s3Location,
      versionId: args.versionId,
      config,
    });
    const where = `s3://${s3Location.bucket}/${s3Location.key}`;
    identity.push(
      `object:   ${where}`,
      `etag:     ${head.eTag ?? "(none)"}${head.versionId ? `   version: ${head.versionId}` : ""}`,
      `modified: ${head.lastModified ?? "unknown"}   size: ${head.size ?? "unknown"} bytes`,
    );
    if (!args.etag && args.guided && head.eTag) {
      // Guided: pin the object shown in the preview; the owner confirms it below.
      args.etag = head.eTag;
      if (head.versionId) args.versionId = head.versionId;
    }
    if (!args.etag) {
      console.log(`Source\n  ${identity.join("\n  ")}`);
      throw new Refusal(
        `An S3 source must be pinned to its exact ETag. If the object above is the one you mean, re-run with:\n  --etag ${shellQuote(head.eTag ?? "")}${head.versionId ? ` --version-id ${shellQuote(head.versionId)}` : ""}`,
      );
    }
    if (!s3.sameETag(head.eTag, args.etag)) {
      throw new Refusal(
        `--etag ${args.etag} does not match the object's current ETag ${head.eTag}. Nothing was changed.`,
      );
    }
    if (args.versionId && head.versionId !== args.versionId) {
      throw new Refusal("The object's version does not match --version-id. Nothing was changed.");
    }
    path = join(workDir, "source.download");
    console.log(`Downloading ${where} ...`);
    await s3.downloadObject({
      location: s3Location,
      eTag: head.eTag ?? args.etag,
      versionId: head.versionId,
      dest: path,
      config,
    });
  } else {
    path = resolve(args.source);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Refusal(
        `source file not found: ${path} (is the backup volume mounted into this container?)`,
      );
    }
    if (!info.isFile()) throw new Refusal(`source is not a regular file: ${path}`);
    identity.push(
      `file:     ${path}`,
      `modified: ${info.mtime.toISOString()}   size: ${info.size} bytes`,
    );
  }

  let format = detectArchiveFormat(await readHead(path));
  let wrapped = false;
  if (format === "gzip") {
    wrapped = true;
    const unwrapped = join(workDir, "source.unwrapped");
    console.log("Source is gzip-wrapped; decompressing ...");
    try {
      await pipeline(
        createReadStream(path),
        createGunzip(),
        createWriteStream(unwrapped, { mode: 0o600 }),
      );
    } catch (error) {
      throw new Refusal(
        `the gzip wrapper is corrupt or truncated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    path = unwrapped;
    format = detectArchiveFormat(await readHead(path));
  }
  if (format === "plain-sql") {
    throw new Refusal(
      "this is a plain-SQL dump. Restore accepts pg_dump custom (-Fc) or tar (-Ft) archives, raw or gzip-wrapped, because only those can be verified before they touch the target.",
    );
  }
  if (format !== "custom" && format !== "tar") {
    throw new Refusal(
      "unrecognized source format (expected a pg_dump -Fc/-Ft archive, optionally gzip-wrapped).",
    );
  }
  identity.push(
    `format:   pg_dump ${format}${wrapped ? " (gzip-wrapped)" : ""}`,
    `sha256:   ${await sha256(path)}`,
  );
  return { path, format, identity };
}

/**
 * Verify the archive reads completely (catalog + every data block).
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 */
async function verifyArchive(path, env) {
  const list = await run("pg_restore", ["--list", path], { env });
  if (list.code !== 0)
    throw new Refusal(`pg_restore --list rejected the archive: ${list.stderr.trim()}`);
  const header = (/** @type {string} */ field) =>
    new RegExp(`^;\\s*${field}:?\\s*(.*)$`, "im").exec(list.stdout)?.[1]?.trim() ?? "unknown";
  const entries = list.stdout.split("\n").filter((line) => /^\d+;/.test(line)).length;
  const full = await run("pg_restore", ["--file=/dev/null", path], { env });
  if (full.code !== 0) {
    throw new Refusal(
      `the archive is incomplete or corrupt (pg_restore could not read it all): ${full.stderr.trim()}`,
    );
  }
  return {
    database: header("Dbname"),
    createdAt: header("Archive created at"),
    dumpVersion: header("Dumped from database version"),
    entries,
  };
}

/** @param {NodeJS.ProcessEnv} env */
async function inspectTarget(env) {
  const serverNum = Number(await query(env, "SHOW server_version_num"));
  if (!Number.isInteger(serverNum)) throw new Refusal("could not read the target server version.");
  const versionOut = (await run("pg_restore", ["--version"], { env })).stdout;
  const clientMajor = Number(/(\d+)/.exec(versionOut)?.[1] ?? Number.NaN);
  const serverMajor = Math.floor(serverNum / 10000);
  const inRecovery = (await query(env, "SELECT pg_is_in_recovery()")) === "t";
  // Everything an application could own: any non-system schema other than an
  // empty public, any object in public, any extension besides plpgsql.
  const occupied =
    (await query(
      env,
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
         UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')`,
    )) === "t";
  const tables = Number(
    await query(
      env,
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('information_schema') AND n.nspname !~ '^pg_'",
    ),
  );
  return { serverMajor, clientMajor, inRecovery, occupied, tables };
}

/**
 * Hold a dedicated session for the restore's lifetime with all three advisory
 * locks (restore, Prisma Migrate, migration runner).
 * Closing its stdin ends the session and releases them.
 * @param {NodeJS.ProcessEnv} env
 */
async function openLockSession(env) {
  const child = spawn("psql", ["-X", "-q", "-A", "-t", "-F", ",", "-v", "ON_ERROR_STOP=1"], {
    env: { ...env, PGAPPNAME: LOCK_APP_NAME },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let closing = false;
  const state = { lost: false };
  const exited = new Promise((resolveExit) => {
    child.on("close", (code) => {
      children.delete(child);
      clearInterval(heartbeat);
      if (!closing && acquired) {
        // The session holding the advisory locks ended (backend terminated,
        // connection dropped): the locks are gone. Stop everything at once;
        // killing psql mid-transaction makes PostgreSQL roll the restore back.
        state.lost = true;
        console.error(
          "FATAL: the lock session ended unexpectedly, so the restore no longer holds its locks. Aborting.",
        );
        for (const other of children) other.kill("SIGTERM");
      }
      resolveExit(code ?? 1);
    });
  });
  let acquired = false;
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat;
  const close = async () => {
    closing = true;
    clearInterval(heartbeat);
    child.stdin.end();
    await exited;
  };
  const reply = await new Promise((resolveReply) => {
    let buffered = "";
    const timer = setTimeout(() => resolveReply(null), 30_000);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = /^([tf]),([tf]),([tf]),(\d+)$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolveReply(match);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolveReply(null);
    });
    child.stdin.write(
      `SELECT pg_try_advisory_lock(${RESTORE_LOCK_KEY}), pg_try_advisory_lock(${PRISMA_MIGRATE_LOCK_KEY}), pg_try_advisory_lock(${MIGRATION_RUNNER_LOCK_KEY}), pg_backend_pid();\n`,
    );
  });
  if (!reply) {
    await close();
    throw new Refusal(
      `could not open the lock session: ${stderr.trim() || "no reply from the database"}`,
    );
  }
  const match = /** @type {RegExpExecArray} */ (reply);
  // Later output (the restore's own query results) is not needed.
  child.stdout.removeAllListeners("data");
  child.stdout.resume();
  acquired = match[1] === "t" && match[2] === "t" && match[3] === "t";
  if (acquired) {
    // An idle psql never notices its backend being terminated; a cheap query
    // every second makes it exit, which fires the lock-loss abort above.
    heartbeat = setInterval(() => {
      if (!child.stdin.destroyed) child.stdin.write("SELECT 1;\n");
    }, 1_000);
    heartbeat.unref();
  }
  return {
    restoreLock: match[1] === "t",
    migrateLock: match[2] === "t",
    runnerLock: match[3] === "t",
    pid: Number(match[4]),
    get lost() {
      return state.lost;
    },
    /**
     * Turn this session into the one that applies the restore, so the same
     * backend holds the locks from the checks through COMMIT.
     * @returns {{ psql: import("node:child_process").ChildProcess, exited: Promise<number> }}
     */
    handOver() {
      closing = true;
      clearInterval(heartbeat);
      // From here on, psql errors are the restore's errors: show them.
      child.stderr.removeAllListeners("data");
      child.stderr.pipe(process.stderr);
      return { psql: child, exited: /** @type {Promise<number>} */ (exited) };
    },
    close,
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {number} lockPid
 */
async function otherConnections(env, lockPid) {
  const out = await query(
    env,
    `SELECT count(*) || '|' || coalesce(string_agg(DISTINCT coalesce(nullif(application_name, ''), '(no application_name)') || ' from ' || coalesce(client_addr::text, 'local socket'), '; '), '')
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> ${lockPid}`,
  );
  const [count, who] = out.split("|");
  return { count: Number(count), who: who ?? "" };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {number} lockPid
 * @param {boolean} allow
 */
async function assertNoWriters(env, lockPid, allow) {
  const { count, who } = await otherConnections(env, lockPid);
  if (count === 0) return;
  if (allow) {
    console.warn(
      `WARNING: ${count} other connection(s) (${who}) — continuing because of --allow-active-connections.`,
    );
    return;
  }
  throw new Refusal(
    `${count} other connection(s) are using ${env.PGDATABASE}: ${who}.\n` +
      "Stop the app and backup scheduler (Dokploy: stop the services) and any\n" +
      "other client, then re-run. If a connection is a pooler or provider monitor you cannot stop and you are\n" +
      "certain nothing writes, add --allow-active-connections. Nothing was changed.",
  );
}

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Hold scheduled deletions for 7 days, inside the restore transaction. Only where the restored database has Prisma history; an existing
 * longer hold is never shortened.
 * @param {string} schema Prisma's schema (`?schema=` of DATABASE_URL)
 */
function restoreHoldSql(schema) {
  const name = sqlLiteral(schema);
  return `DO $restore_hold$ BEGIN IF to_regclass(format('%I._prisma_migrations', ${name}::text)) IS NOT NULL THEN
  EXECUTE format(${sqlLiteral(HOLD_DDL)}, ${name}::text);
  EXECUTE format('INSERT INTO %I."_cockpit_context_hold" AS h (reason, until) VALUES (''restore'', now() + interval ''7 days'')
                  ON CONFLICT (reason) DO UPDATE SET until = greatest(h.until, EXCLUDED.until), set_at = now()', ${name}::text);
END IF; END $restore_hold$;
`;
}

/**
 * Stream the archive as SQL into ONE transaction. COMMIT is sent only after
 * pg_restore has produced the whole script successfully; any failure ends
 * psql's input without COMMIT, so PostgreSQL rolls everything back.
 * The transaction runs IN the lock session (its backend has held the
 * advisory locks since before the checks and the snapshot), so no other
 * restore or migration can run at any point between validation and COMMIT.
 * If that backend dies, the transaction dies with it.
 * @param {string} archive
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} replace
 * @param {{ psql: import("node:child_process").ChildProcess, exited: Promise<number> }} session
 * @param {string} holdSql written after the archive, before COMMIT
 */
function applyArchive(archive, env, replace, session, holdSql) {
  return new Promise((resolvePromise) => {
    const psql = session.psql;
    const dump = spawn("pg_restore", ["--no-owner", "--no-privileges", "--file=-", archive], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.add(dump);
    let psqlDone = false;
    let psqlCode = 0;
    let dumpCode = /** @type {number | null} */ (null);
    psql.stdin.on("error", () => {
      dump.kill("SIGTERM");
    });
    psql.stdin.write("BEGIN;\nSET LOCAL client_min_messages = warning;\n");
    if (replace) {
      // The schema drop runs in the same transaction as the restore: either
      // the archive fully replaces the old contents or nothing changes.
      psql.stdin.write(`DO $restore$
DECLARE target_schema text;
BEGIN
  FOR target_schema IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', target_schema);
  END LOOP;
END
$restore$;
CREATE SCHEMA public;
`);
    }
    dump.stdout.pipe(psql.stdin, { end: false });
    dump.on("close", (code) => {
      children.delete(dump);
      dumpCode = code ?? 1;
      if (!psqlDone && dumpCode === 0) psql.stdin.write(`${holdSql}COMMIT;\n`);
      psql.stdin.end();
    });
    session.exited.then((code) => {
      psqlDone = true;
      psqlCode = code;
      if (dumpCode === null) dump.kill("SIGTERM");
      const finish = () =>
        resolvePromise({ ok: psqlCode === 0 && dumpCode === 0, psqlCode, dumpCode });
      if (dumpCode === null) dump.once("close", finish);
      else finish();
    });
  });
}

/** @param {NodeJS.ProcessEnv} env */
async function migrationSummary(env) {
  const exists = await query(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL");
  if (exists !== "t")
    return "no _prisma_migrations table in the restored data (pre-Migrate backup?)";
  const out = await query(
    env,
    "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '|' || coalesce((SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1), '(none)') FROM public._prisma_migrations",
  );
  const [count, latest] = out.split("|");
  return `${count} applied migration(s); latest: ${latest}`;
}

/** Backups in /backups, newest first. */
async function localBackups() {
  let names;
  try {
    names = await readdir(BACKUPS_DIR);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const info = await stat(join(BACKUPS_DIR, name));
      if (info.isFile()) entries.push({ name, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Removed while listing (a prune); skip it.
    }
  }
  return entries;
}

/** @param {string} question */
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function main() {
  let args;
  try {
    args = parseRestoreArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`FATAL: ${error.message}\n\n${RESTORE_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    console.log(RESTORE_USAGE);
    return 0;
  }
  if (args.list) {
    const backups = sortBackups(await localBackups());
    if (!backups.length) {
      console.log(
        `No backups in ${BACKUPS_DIR} (is the backups volume mounted into this container?).`,
      );
      return 0;
    }
    console.log(`Backups in ${BACKUPS_DIR}, newest first:`);
    for (const backup of backups)
      console.log(
        `  ${backup.name}   ${new Date(backup.mtimeMs).toISOString()}   ${backup.size} bytes`,
      );
    return 0;
  }
  if (args.guided && !process.stdin.isTTY) {
    throw new Refusal(
      "--guided asks before changing anything, so it needs a terminal: run the container with -it. Nothing was changed.",
    );
  }
  if (args.source === "latest") {
    const latest = pickLatest(await localBackups());
    if (!latest)
      throw new Refusal(
        `there is no backup in ${BACKUPS_DIR} to restore (is the backups volume mounted?). Nothing was changed.`,
      );
    args.source = join(BACKUPS_DIR, latest);
    console.log(`Newest backup: ${args.source}`);
  }

  let pgEnv;
  try {
    pgEnv = pgEnvFromUrl(process.env.DATABASE_URL);
  } catch (error) {
    throw new Refusal(`target: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** @type {NodeJS.ProcessEnv} */
  // The target is exactly DATABASE_URL: inherited libpq variables (PGHOSTADDR,
  // PGSERVICE, …) could silently redirect the connection, so drop them all.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PG")),
  );
  const env = { ...inherited, ...pgEnv, PGCONNECT_TIMEOUT: "10" };
  const database = pgEnv.PGDATABASE;
  const expected = expectedConfirmation(database);

  console.log("== Restore ==");
  console.log(
    "Before a real restore: stop and drain every writer of the target (app, backup scheduler, other",
  );
  console.log("clients). Restore refuses while other sessions are connected.\n");

  const workDir = await mkdtemp(join(tmpdir(), "cockpit-context-restore-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.once(signal, () => {
      // Killing psql before COMMIT rolls the restore back.
      for (const child of children) child.kill("SIGTERM");
      cleanup();
      console.error(
        `\nFATAL: interrupted by ${signal}; an unfinished restore transaction is rolled back.`,
      );
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    });
  }
  try {
    console.log("Verifying source ...");
    const source = await prepareSource(args, workDir);
    const archive = await verifyArchive(source.path, env);
    const target = await inspectTarget(env);

    console.log(`\nSource\n  ${source.identity.join("\n  ")}`);
    console.log(
      `  dumped:   ${archive.createdAt} from database "${archive.database}" (PostgreSQL ${archive.dumpVersion}), ${archive.entries} catalog entries`,
    );
    console.log(
      `\nTarget\n  database: ${database} on ${pgEnv.PGHOST}:${pgEnv.PGPORT} (PostgreSQL ${target.serverMajor})\n  contents: ${target.occupied ? `NOT EMPTY (${target.tables} table(s))` : "empty"}\n`,
    );

    if (!Number.isFinite(target.clientMajor) || target.clientMajor < target.serverMajor) {
      throw new Refusal(
        `pg_restore is version ${target.clientMajor} but the server is ${target.serverMajor}. Raise ARG PG_MAJOR in the Dockerfiles and rebuild.`,
      );
    }
    if (target.inRecovery)
      throw new Refusal(
        "the target is a read-only replica (pg_is_in_recovery). Point DATABASE_URL at the primary.",
      );

    const rerun = [
      "restore",
      shellQuote(args.source),
      ...(args.etag ? ["--etag", shellQuote(args.etag)] : []),
      ...(args.versionId ? ["--version-id", shellQuote(args.versionId)] : []),
      ...(target.occupied ? ["--replace"] : []),
      "--confirm",
      expected,
    ].join(" ");
    if (args.confirm === null && args.guided) {
      const answer = await ask(guidedQuestion(database, target.occupied));
      if (!guidedAnswerConfirms(answer, database, target.occupied))
        throw new Refusal(
          target.occupied && answer.trim()
            ? `cancelled — "${answer.trim()}" is not the database name. Nothing was changed.`
            : "cancelled — nothing was changed.",
        );
      args.confirm = expected;
      args.replace = target.occupied;
    }
    if (args.confirm === null) {
      throw new Refusal(
        `preview only — nothing was changed.\nTo restore this source into "${database}"${target.occupied ? ", replacing its current contents" : ""}, run:\n  ${rerun}`,
      );
    }
    if (args.confirm !== expected) {
      throw new Refusal(
        `--confirm must be exactly ${expected} for this target (got ${args.confirm}). Nothing was changed.`,
      );
    }
    if (target.occupied && !args.replace) {
      throw new Refusal(
        `the target database "${database}" is not empty (${target.tables} table(s)). Restore into a new empty database,\nor add --replace to snapshot and then replace its contents:\n  ${rerun}`,
      );
    }

    const lock = await openLockSession(env);
    try {
      if (!lock.restoreLock) throw new Refusal("another restore is running against this database.");
      if (!lock.migrateLock) {
        throw new Refusal(
          "a Prisma migration is running against this database (its advisory lock is held). Wait for it to finish.",
        );
      }
      if (!lock.runnerLock) {
        throw new Refusal(
          "the migration runner (scripts/db/migrate-runtime.mjs apply: MIGRATE_ON_START=true or the `migrate` job) is working on this database (its advisory lock is held). Wait for it to finish, then stop the app and backup scheduler. Nothing was changed.",
        );
      }
      // The target was inspected before the locks were taken; a migration or
      // another restore may have changed it in between. Decide on what is
      // there now, under the locks.
      const recheck = await inspectTarget(env);
      if (recheck.occupied !== target.occupied) {
        throw new Refusal(
          `the target database "${database}" changed while the restore was preparing (it is now ${recheck.occupied ? "NOT EMPTY" : "empty"}). Nothing was changed; re-run to see a fresh preview.`,
        );
      }
      if (target.occupied) {
        // Two queries: PostgreSQL resolves a table reference while parsing,
        // so a CASE guard cannot protect a database that has no history table.
        const hasHistory =
          (await query(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")) === "t";
        const unfinished = hasHistory
          ? await query(
              env,
              "SELECT coalesce(string_agg(migration_name, ', '), '') FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL",
            )
          : "";
        if (unfinished) {
          console.warn(
            `WARNING: the target records unfinished (failed) migration(s): ${unfinished}. No migration is running (lock is free); the restore replaces this history.`,
          );
        }
      }
      await assertNoWriters(env, lock.pid, args.allowActiveConnections);

      if (target.occupied) {
        if (args.skipSnapshot) {
          console.warn(
            "WARNING: --skip-snapshot: the current contents are NOT backed up by this command. Make sure a provider snapshot exists.",
          );
        } else {
          console.log("Snapshotting the current target before replacing it ...");
          const snapshot = await run(
            "bash",
            [join(HERE, "pre-migrate.sh"), "--label", "pre-restore", "--required"],
            {
              env,
              capture: false,
            },
          );
          if (snapshot.code !== 0) {
            throw new Refusal(
              "the pre-restore snapshot failed, so the target was not touched. Mount a writable /backups volume or set BACKUP_S3_*,\nor, only if a provider snapshot exists, add --skip-snapshot.",
            );
          }
        }
        // A writer may have connected while the snapshot ran.
        await assertNoWriters(env, lock.pid, args.allowActiveConnections);
      }

      console.log(`Restoring into "${database}" in a single transaction ...`);
      if (lock.lost)
        throw new Refusal(
          "the lock session ended before the restore started; nothing was changed.",
        );
      // The lock session itself runs the restore transaction: the locks are
      // never released between the checks and COMMIT.
      const result = await applyArchive(
        source.path,
        env,
        target.occupied,
        lock.handOver(),
        restoreHoldSql(prismaSchemaName(process.env.DATABASE_URL ?? "")),
      );
      if (!result.ok) {
        console.error(
          `FATAL: restore failed (psql exit ${result.psqlCode}, pg_restore exit ${result.dumpCode}). The transaction was rolled back; "${database}" is unchanged.`,
        );
        return 1;
      }
      console.log(`\nRestore complete. ${await migrationSummary(env)}.`);
    } finally {
      await lock.close();
    }
    if (process.env.RESTORE_DRILL === "1") {
      // restore-drill (drill.mjs) restored a throwaway copy; it checks it next.
      return 0;
    }
    console.log(`Next steps:
  1. Check the restored data with read-only queries.
  2. Deploy an image whose packages/db/prisma/migrations includes that latest migration.
     A newer image applies its pending migrations on start; an older one starts only if
     every newer migration can be rolled back — otherwise deploy the matching or a newer commit.
  3. Start (or redeploy) the app and backup scheduler again, and confirm backups are running for this
     database. Scheduled deletions wait 7 days after a restore; to get back data a deletion
     already removed, ship the recover change within those 7 days.
See docs/backup-restore.md.`);
    return 0;
  } finally {
    cleanup();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`\nREFUSED: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
