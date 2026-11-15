import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateApp,
  evaluateCompression,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";

const project = "compose-cockpit-context-abc123";
const app = {
  id: "container-1",
  image: "sha256:app",
  project,
  service: "app",
  status: "running",
  running: true,
  restarts: 0,
  health: "healthy",
};

test("only a Compose project, an HTTPS origin and a commit are accepted, without credentials", () => {
  assert.throws(() => parseOptions([]), /required/);
  const ok = ["--project", project, "--url", "https://app.example.com", "--commit", "ABCDEF1"];
  assert.equal(parseOptions(ok).timeout, 600);
  assert.equal(parseOptions(ok).commit, "abcdef1");
  // Without the expected commit an earlier healthy release could pass.
  assert.throws(
    () => parseOptions(["--project", project, "--url", "https://app.example.com"]),
    /--commit are required/,
  );
  assert.throws(() => parseOptions([...ok.slice(0, 5), "main"]), /commit SHA/);
  // The Swarm-era --server option is gone.
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://app.example.com"]),
    /Use --project/,
  );
  assert.throws(
    () =>
      parseOptions([
        "--project",
        "Bad Name",
        "--url",
        "https://app.example.com",
        "--commit",
        "abcdef1",
      ]),
    /Invalid Compose project/,
  );
  assert.throws(
    () =>
      parseOptions([
        "--project",
        project,
        "--url",
        "https://user:password@example.com",
        "--commit",
        "abcdef1",
      ]),
    /credentials/,
  );
});

test("exactly one labelled, healthy app container is ready; a starting one is not yet", () => {
  assert.equal(evaluateApp(project, [app]), true);
  assert.equal(evaluateApp(project, [{ ...app, health: "starting" }]), false);
  assert.equal(evaluateApp(project, [{ ...app, status: "restarting", running: true }]), false);
  assert.equal(evaluateApp(project, [{ ...app, status: "created", running: false }]), false);
});

test("a missing, duplicated, mislabelled, unhealthy, stopped or unchecked app cannot report success", () => {
  assert.throws(() => evaluateApp(project, []), /no app container/);
  assert.throws(
    () => evaluateApp(project, [app, { ...app, id: "container-2" }]),
    /exactly one app container/,
  );
  assert.throws(() => evaluateApp(project, [{ ...app, project: "other" }]), /label mismatch/);
  assert.throws(() => evaluateApp(project, [{ ...app, service: "backup" }]), /label mismatch/);
  assert.throws(() => evaluateApp(project, [{ ...app, health: "unhealthy" }]), /unhealthy/);
  assert.throws(
    () => evaluateApp(project, [{ ...app, status: "exited", running: false, health: "starting" }]),
    /has exited/,
  );
  assert.throws(() => evaluateApp(project, [{ ...app, health: null }]), /no healthcheck/);
});

/** Inert Docker: answers the project-scoped `ps` and the container inspect. */
function fakeDocker({
  health = "healthy",
  replaced = false,
  restarted = false,
  seen = [],
  buildCommit = "0123456789abcdef0123456789abcdef01234567",
} = {}) {
  let inspects = 0;
  return async (args) => {
    seen.push(args);
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "exec") {
      // Only the baked build commit is read from inside the container.
      assert.deepEqual(args, ["exec", "container-1", "cat", "/app/apps/server/dist/BUILD_COMMIT"]);
      return `${buildCommit}\n`;
    }
    if (args[0] === "ps") {
      assert.ok(args.includes(`label=com.docker.compose.project=${project}`));
      assert.ok(args.includes("label=com.docker.compose.service=app"));
      // A retained `docker compose run app …` container is not a second replica.
      assert.ok(args.includes("label=com.docker.compose.oneoff=False"));
      return "container-1";
    }
    assert.deepEqual(args.slice(0, 4), ["inspect", "--type", "container", "container-1"]);
    const later = inspects++ > 0;
    return JSON.stringify({
      ...app,
      health,
      id: replaced && later ? "container-2" : app.id,
      restarts: restarted && later ? 1 : 0,
    });
  };
}

const commit = "0123456789abcdef0123456789abcdef01234567";
const options = { project, url: "https://example.com", commit, timeout: 1 };

test("verification requires the healthy app container and JSON public readiness", async () => {
  let queried = false;
  const seen = [];
  await verifyDeployment(options, {
    inspect: fakeDocker({ seen }),
    log: () => {},
    fetchReady: async (url) => {
      queried = true;
      assert.equal(url, "https://example.com/ready");
      return { status: 200, json: async () => ({ ok: true, commit }) };
    },
    fetchPage: async () => ({
      headers: new Headers({ "content-encoding": "br" }),
      arrayBuffer: async () => new ArrayBuffer(4096),
    }),
  });
  assert.equal(queried, true);
  // Plain containers only: no Swarm service or task inspection.
  assert.ok(!seen.some((args) => args[0] === "service" || args.includes("task")));
  await assert.rejects(
    verifyDeployment(options, { inspect: fakeDocker({ health: null }), log: () => {} }),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(options, { inspect: fakeDocker({ replaced: true }), log: () => {} }),
    /changed/,
  );
  await assert.rejects(
    verifyDeployment(options, { inspect: fakeDocker({ restarted: true }), log: () => {} }),
    /restarted during verification/,
  );
});

test("an earlier healthy release does not pass: /ready must report the expected commit", async () => {
  for (const reported of ["fedcba9876543210fedcba9876543210fedcba98", null, undefined]) {
    const controller = new AbortController();
    let polls = 0;
    await assert.rejects(
      verifyDeployment(options, {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => {
          polls++;
          return { status: 200, json: async () => ({ ok: true, commit: reported }) };
        },
        sleep: async () => {
          controller.abort();
        },
      }),
      /timed out or was cancelled/,
      String(reported),
    );
    assert.equal(polls, 1);
  }
  // A short expected SHA matches the full one /ready reports.
  await verifyDeployment(
    { ...options, commit: commit.slice(0, 7) },
    {
      inspect: fakeDocker(),
      log: () => {},
      fetchReady: async () => ({ status: 200, json: async () => ({ ok: true, commit }) }),
      fetchPage: async () => ({
        headers: new Headers({ "content-encoding": "br" }),
        arrayBuffer: async () => new ArrayBuffer(4096),
      }),
    },
  );
});

test("the selected container must itself run the expected commit, whatever the URL answers", async () => {
  const ready = async () => ({ status: 200, json: async () => ({ ok: true, commit }) });
  await assert.rejects(
    verifyDeployment(options, {
      inspect: fakeDocker({ buildCommit: "fedcba9876543210fedcba9876543210fedcba98" }),
      log: () => {},
      fetchReady: ready,
    }),
    /container runs commit fedcba987654, not 0123456789ab/,
  );
  await assert.rejects(
    verifyDeployment(options, {
      inspect: fakeDocker({ buildCommit: "" }),
      log: () => {},
      fetchReady: ready,
    }),
    /does not know its commit/,
  );
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(options, {
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
    }),
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
    await verifyDeployment(options, {
      inspect: fakeDocker(),
      log: (line) => messages.push(line),
      fetchReady: async () => ({ status: 200, json: async () => ({ ok: true, commit }) }),
      fetchPage,
    });
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
  // The entrypoint execs the CMD and the one-shot jobs under tini.
  writeFileSync(join(dir, "tini"), '#!/bin/sh\n[ "$1" = -- ] && shift\nexec "$@"\n', {
    mode: 0o755,
  });
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
        .map((line) => JSON.parse(line))
        // The backups startup check (pre-migrate.sh --startup-notice) is
        // covered by scripts/docker-entrypoint.test.mjs.
        .filter((call) => !call.args.includes("--startup-notice")),
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
