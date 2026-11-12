import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateCompression,
  evaluateService,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";

const service = {
  id: "service",
  version: 1,
  image: "server:latest",
  generation: 2,
  mode: { Replicated: { Replicas: 1 } },
};
const task = {
  id: "task",
  image: service.image,
  generation: 2,
  slot: 1,
  desired: "running",
  status: "running",
  container: { ContainerID: "container", ExitCode: 0 },
};

test("only the single app role is accepted, without credentials", () => {
  assert.throws(() => parseOptions([]), /required/);
  assert.equal(parseOptions(["--server", "web", "--url", "https://app.example.com"]).timeout, 600);
  assert.throws(
    () =>
      parseOptions(["--server", "web", "--applier", "schema", "--url", "https://app.example.com"]),
    /Use --server/,
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://user:password@example.com"]),
    /credentials/,
  );
});

test("a healthy task from the previous generation cannot pass a new deployment", () => {
  assert.equal(evaluateService("server", service, [{ ...task, generation: 1 }]), null);
  assert.equal(evaluateService("server", service, [{ ...task, status: "complete" }]), null);
});

test("failed or rolled-back deployment and incomplete replica set cannot report success", () => {
  assert.throws(
    () => evaluateService("server", service, [{ ...task, status: "failed" }]),
    /failed/,
  );
  assert.throws(
    () =>
      evaluateService("server", { ...service, update: { State: "rollback_completed" } }, [task]),
    /rolled back/,
  );
  assert.throws(
    () => evaluateService("server", { ...service, mode: { Replicated: { Replicas: 2 } } }, [task]),
    /exactly one app replica/,
  );
});

function fakeDocker({ health = "healthy", mutate = false } = {}) {
  let reads = 0;
  return async (args) => {
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "service" && args[1] === "inspect")
      return JSON.stringify({ ...service, generation: mutate && reads++ > 0 ? 3 : 2 });
    if (args[0] === "service") return "task";
    if (args[2] === "task") return JSON.stringify(task);
    return JSON.stringify({ running: true, health });
  };
}

test("verification requires healthy selected runtime and JSON public readiness", async () => {
  let queried = false;
  await verifyDeployment(
    { server: "web", url: "https://example.com", timeout: 1 },
    {
      inspect: fakeDocker(),
      log: () => {},
      fetchReady: async (url) => {
        queried = true;
        assert.equal(url, "https://example.com/ready");
        return { status: 200, json: async () => ({ ok: true }) };
      },
      fetchPage: async () => ({
        headers: new Headers({ "content-encoding": "br" }),
        arrayBuffer: async () => new ArrayBuffer(4096),
      }),
    },
  );
  assert.equal(queried, true);
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ health: null }), log: () => {} },
    ),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ mutate: true }), log: () => {} },
    ),
    /changed/,
  );
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => ({
          status: 200,
          json: async () => {
            throw new Error("HTML");
          },
        }),
        sleep: async () => {
          controller.abort();
        },
      },
    ),
    /cancelled/,
  );
});

test("compression is classified per content-encoding token, including identity and multi-encodings", () => {
  assert.equal(evaluateCompression("gzip"), true);
  assert.equal(evaluateCompression("BR"), true);
  assert.equal(evaluateCompression("zstd"), true);
  assert.equal(evaluateCompression("gzip, br"), true);
  assert.equal(evaluateCompression("identity"), false);
  assert.equal(evaluateCompression(""), false);
  assert.equal(evaluateCompression(null), false);
});

test("compression advisory passes silently when compressed and warns without failing when not", async () => {
  const run = async (fetchPage) => {
    const messages = [];
    await verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: (line) => messages.push(line),
        fetchReady: async () => ({ status: 200, json: async () => ({ ok: true }) }),
        fetchPage,
      },
    );
    return messages;
  };
  const page = (encoding, size) => async (url, init) => {
    assert.equal(url, "https://example.com/");
    assert.match(init.headers["accept-encoding"], /gzip/);
    assert.equal(init.redirect, "follow");
    return {
      headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  };
  const verified = (messages) => messages.some((line) => line.startsWith("Deployment verified:"));

  const compressed = await run(page("br", 4096));
  assert.ok(compressed.some((line) => /content-encoding: br/.test(line) && !/WARNING/.test(line)));
  assert.ok(verified(compressed));

  const uncompressed = await run(page(null, 4096));
  const warning = uncompressed.find((line) => line.includes("WARNING (non-fatal)"));
  assert.match(warning, /responded uncompressed/);
  assert.match(warning, /traefik\.http\.middlewares\.<name>\.compress/);
  assert.match(warning, /docs\/deploy\.md § Response compression\.$/);
  assert.ok(verified(uncompressed));

  const identity = await run(page("identity", 4096));
  assert.match(
    identity.find((line) => line.includes("WARNING")),
    /uncompressed/,
  );

  const tiny = await run(page(null, 12));
  assert.match(
    tiny.find((line) => line.includes("WARNING")),
    /under ~1 KB/,
  );

  const unreadable = await run(async () => {
    throw new Error("offline");
  });
  assert.match(
    unreadable.find((line) => line.includes("WARNING")),
    /could not be verified/,
  );
});

// Exercise the real shell entrypoint with inert executables. No /app files,
// Docker, database or server process are involved.
function entrypointFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-context-entrypoint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = `#!${process.execPath}
if (process.argv[2] === "-p") console.log("c343c12a-4bae-42f3-a182-182d890a8584");
else {
  console.log(JSON.stringify({args: process.argv.slice(2), id: process.env.COCKPIT_CONTEXT_INSTANCE_ID ?? null}));
  if (process.env.FIXTURE_FAIL_MIGRATION && process.argv[2]?.endsWith("migrate-runtime.mjs")) process.exit(42);
}
`;
  for (const name of ["node", "bash"]) writeFileSync(join(dir, name), stub, { mode: 0o755 });
  const entry = fileURLToPath(new URL("./docker-entrypoint.sh", import.meta.url));
  return (args, extra = {}) => {
    const result = spawnSync("/bin/sh", [entry, ...args], {
      encoding: "utf8",
      env: { PATH: dir, ...extra },
    });
    return {
      ...result,
      calls: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  };
}

test("all image operation commands bypass server auth and start no instance", (t) => {
  const run = entrypointFixture(t);
  const routes = [
    [["migrate"], ["/app/scripts/db/migrate-runtime.mjs", "apply"]],
    [
      ["hold-deletions", "7"],
      ["/app/scripts/db/migrate-runtime.mjs", "hold", "7"],
    ],
    [
      ["restore", "--list"],
      ["/app/scripts/backup/restore.sh", "--list"],
    ],
    [
      ["backup", "--keep", "3"],
      ["/app/scripts/backup/pre-migrate.sh", "--label", "manual", "--required", "--keep", "3"],
    ],
    [["backup-schedule"], ["/app/scripts/backup/schedule.mjs", "run"]],
    [
      ["restore-drill", "archive.dump"],
      ["/app/scripts/backup/drill.mjs", "archive.dump"],
    ],
  ];
  for (const [args, expected] of routes) {
    const result = run(args, {
      DATABASE_URL: "postgresql://fixture@localhost/fixture",
      COCKPIT_CONTEXT_INSTANCE_ID: "inherited-server-id",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [{ args: expected, id: null }]);
  }
  for (const command of ["migrate", "hold-deletions"]) {
    const result = run([command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL/);
    assert.deepEqual(result.calls, []);
  }
});

test("server applies by default, waits when disabled, and shares a fresh identity with CMD", (t) => {
  const run = entrypointFixture(t);
  const env = {
    DATABASE_URL: "postgresql://fixture@localhost/fixture",
    BETTER_AUTH_SECRET: "fixture-only",
    COCKPIT_CONTEXT_INSTANCE_ID: "old",
  };
  for (const [setting, mode] of [
    [undefined, "apply"],
    ["false", "wait"],
  ]) {
    const result = run(["node", "apps/server/dist/index.mjs"], {
      ...env,
      ...(setting ? { MIGRATE_ON_START: setting } : {}),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call.args),
      [
        ["/app/scripts/db/migrate-runtime.mjs", mode, "--role", "server"],
        ["apps/server/dist/index.mjs"],
      ],
    );
    assert.match(result.calls[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(result.calls[0].id, result.calls[1].id);
    assert.notEqual(result.calls[0].id, "old");
  }
  const failed = run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    FIXTURE_FAIL_MIGRATION: "true",
  });
  assert.equal(failed.status, 42);
  assert.equal(failed.calls.length, 1);
  const invalid = run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    MIGRATE_ON_START: "invalid",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /must be true or false/);
  assert.deepEqual(invalid.calls, []);
  const missing = run(["node", "apps/server/dist/index.mjs"], { DATABASE_URL: env.DATABASE_URL });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /BETTER_AUTH_SECRET/);
  assert.deepEqual(missing.calls, []);
});
