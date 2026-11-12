/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Exact tag, the Alpine variant of compose.yaml's postgres:18.6, so the
// disposable fixture never floats to a newer minor (docs/hosting.md).
const POSTGRES_IMAGE = "postgres:18.6-alpine";
const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck() {
  const [jobs, { default: prisma }, { z }] = await Promise.all([
    import("../packages/jobs/src/index.ts"),
    import("../packages/db/src/index.ts"),
    import("zod"),
  ]);
  const runId = randomUUID().slice(0, 8);
  const seen = [];
  let failures = 0;
  const echo = jobs.defineJob(`ops.echo-${runId}`, z.object({ message: z.string() }));
  const flaky = jobs.defineJob(`ops.flaky-${runId}`, z.object({}), {
    maxAttempts: 2,
    backoff: { baseMs: 10, maxMs: 10 },
  });
  const slow = jobs.defineJob(`ops.slow-${runId}`, z.object({ n: z.number() }));
  const runners = [];
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await delay(25);
    }
  };
  const statusOf = async (id) =>
    (await prisma.backgroundJob.findUnique({ where: { id }, select: { status: true } }))?.status;
  try {
    // 1. Real claim SQL, retries with backoff, and success bookkeeping.
    const runner = jobs.createJobRunner({
      jobs: [
        jobs.handleJob(echo, async ({ payload }) => {
          seen.push(payload.message);
        }),
        jobs.handleJob(flaky, async ({ attempt }) => {
          if (attempt === 1) {
            failures++;
            throw new Error("first attempt fails");
          }
        }),
      ],
      pollIntervalMs: 50,
    });
    runners.push(runner);
    await runner.start();
    const ok = await jobs.enqueueJob(echo, { message: "hello" });
    const retried = await jobs.enqueueJob(flaky, {});
    await waitFor(async () => (await statusOf(ok.id)) === "succeeded", "echo success");
    await waitFor(async () => (await statusOf(retried.id)) === "succeeded", "retry success");
    assert.deepEqual(seen, ["hello"]);
    assert.equal(failures, 1);
    const retriedRow = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: retried.id } });
    assert.equal(retriedRow.attempts, 2);
    assert.equal(retriedRow.lockedBy, null);

    // 2. Dedupe keys insert exactly one row under a race.
    const racing = await Promise.all(
      Array.from({ length: 5 }, () =>
        jobs.enqueueJob(echo, { message: "once" }, { dedupeKey: `ops-${runId}` }),
      ),
    );
    assert.equal(new Set(racing.map((r) => r.id)).size, 1);
    assert.equal(racing.filter((r) => r.created).length, 1);
    await waitFor(async () => seen.includes("once"), "deduped job");
    await runner.stop();

    // 3. SKIP LOCKED: two runners never execute one row twice.
    const executions = new Map();
    const handler = jobs.handleJob(slow, async ({ id }) => {
      executions.set(id, (executions.get(id) ?? 0) + 1);
      await delay(20);
    });
    const a = jobs.createJobRunner({ jobs: [handler], concurrency: 4, pollIntervalMs: 20 });
    const b = jobs.createJobRunner({ jobs: [handler], concurrency: 4, pollIntervalMs: 20 });
    runners.push(a, b);
    const ids = [];
    for (let n = 0; n < 40; n++) ids.push((await jobs.enqueueJob(slow, { n })).id);
    await Promise.all([a.start(), b.start()]);
    await waitFor(
      async () =>
        (await prisma.backgroundJob.count({ where: { id: { in: ids }, status: "succeeded" } })) ===
        ids.length,
      "parallel runners",
    );
    assert.equal(executions.size, ids.length);
    assert.ok([...executions.values()].every((count) => count === 1));
    await Promise.all([a.stop(), b.stop()]);

    // 4. Boot recovery returns an orphaned running row to the queue.
    const orphan = await prisma.backgroundJob.create({
      data: {
        type: echo.type,
        payload: { message: "orphan" },
        status: "running",
        attempts: 1,
        lockedAt: new Date(Date.now() - 60_000),
        lockedBy: "dead-process",
      },
      select: { id: true },
    });
    const recovering = jobs.createJobRunner({
      jobs: [
        jobs.handleJob(echo, async ({ payload }) => {
          seen.push(payload.message);
        }),
      ],
      pollIntervalMs: 50,
      staleLockMs: 30_000,
    });
    runners.push(recovering);
    await recovering.start();
    await waitFor(async () => (await statusOf(orphan.id)) === "succeeded", "orphan recovery");
    assert.ok(seen.includes("orphan"));
    console.log("jobs: claim, retry, dedupe, SKIP LOCKED, and boot recovery passed.");
  } finally {
    await Promise.all(runners.map((runner) => runner.stop()));
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    await runtimeCheck();
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  const environment = { PATH: process.env.PATH };
  const docker = (...args) =>
    execFileSync("docker", args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  for (const image of [POSTGRES_IMAGE]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "cockpit-context-runtime-operations-"));
  const containers = [];
  try {
    const password = randomUUID();
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `cockpit-context-runtime-pg-${randomUUID()}`,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      POSTGRES_IMAGE,
    );
    containers.push(postgres);
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the real Prisma config and schema away from root .env. Only installed
    // packages are linked; dotenv resolves a missing file inside this fixture.
    const prismaCwd = resolve(temporary, "packages/db");
    mkdirSync(prismaCwd, { recursive: true });
    cpSync(resolve(root, "packages/db/prisma.config.ts"), resolve(prismaCwd, "prisma.config.ts"));
    for (const folder of ["schema", "migrations", "fixtures"]) {
      cpSync(resolve(root, "packages/db/prisma", folder), resolve(prismaCwd, "prisma", folder), {
        recursive: true,
      });
    }
    cpSync(resolve(root, "packages/db/package.json"), resolve(prismaCwd, "package.json"));
    for (const folder of ["db", "backup"]) {
      cpSync(resolve(root, "scripts", folder), resolve(temporary, "scripts", folder), {
        recursive: true,
      });
    }
    symlinkSync(resolve(root, "node_modules"), resolve(temporary, "node_modules"), "dir");
    symlinkSync(
      resolve(root, "packages/db/node_modules"),
      resolve(prismaCwd, "node_modules"),
      "dir",
    );
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "production",
      BACKUP_SCHEDULE: "off",
    };
    for (const operation of ["empty database", "unchanged migrations"]) {
      execFileSync(
        process.execPath,
        [resolve(temporary, "scripts/db/migrate-runtime.mjs"), "apply"],
        {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 180_000,
          stdio: "pipe",
        },
      );
      console.log(`Canonical migration with real Prisma: ${operation} passed.`);
    }
    const result = execFileSync(process.execPath, ["--import", "tsx", file, "--runtime-child"], {
      cwd: root,
      env: {
        ...fixtureEnv,
        RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
      },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    process.stdout.write(result);
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("stop", "--time", "2", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
