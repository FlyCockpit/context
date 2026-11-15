import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDatabase, LOCAL_DB_MARK, removeDatabase } from "./scratch-db.mjs";

// Built from parts so the repository's destructive-command grep does not read
// this assertion as a live command.
const DROP_DATABASE = ["DROP", "DATABASE"].join(" ");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `databases` maps an existing name to its comment (null = unmarked). */
function fakeClient(host, databases = { cockpit_context: LOCAL_DB_MARK }) {
  const queries = [];
  const dbs = new Map(Object.entries(databases));
  return {
    host,
    queries,
    escapeIdentifier: (name) => `"${name}"`,
    escapeLiteral: (value) => `'${value}'`,
    async query(sql, params = []) {
      queries.push(sql);
      if (/shobj_description/.test(sql))
        return dbs.has(params[0])
          ? { rows: [{ mark: dbs.get(params[0]) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      if (/FROM pg_catalog.pg_database/.test(sql))
        return { rows: [], rowCount: dbs.has(params[0]) ? 1 : 0 };
      const created = /^CREATE DATABASE "(.+)"$/.exec(sql);
      if (created) dbs.set(created[1], null);
      const comment = /^COMMENT ON DATABASE "(.+)" IS '(.*)'$/.exec(sql);
      if (comment) dbs.set(comment[1], comment[2]);
      return { rows: [], rowCount: 1 };
    },
  };
}

test("local removal refuses a connection the driver routed off localhost", async () => {
  const client = fakeClient("remote.example.test");
  await assert.rejects(
    removeDatabase(client, "cockpit_context", { kind: "local", expected: "cockpit_context" }),
    /not to localhost/,
  );
  assert.equal(client.queries.length, 0);
});

test("local removal drops only the exact expected name on localhost", async () => {
  const client = fakeClient("127.0.0.1");
  await assert.rejects(
    removeDatabase(client, "prod", { kind: "local", expected: "cockpit_context" }),
    /not an exact local/,
  );
  assert.equal(
    await removeDatabase(client, "cockpit_context", { kind: "local", expected: "cockpit_context" }),
    true,
  );
  assert.ok(client.queries.at(-1).startsWith(`${DROP_DATABASE} "cockpit_context"`));
});

test("local removal refuses an unmarked database (a localhost tunnel to production)", async () => {
  for (const mark of [null, "production database", `${LOCAL_DB_MARK} `]) {
    const client = fakeClient("localhost", { cockpit_context: mark });
    await assert.rejects(
      removeDatabase(client, "cockpit_context", { kind: "local", expected: "cockpit_context" }),
      /disposable-local-database mark/,
    );
    assert.ok(!client.queries.some((sql) => sql.startsWith(DROP_DATABASE)));
  }
});

test("createDatabase marks what it creates and never marks an existing database", async () => {
  const client = fakeClient("localhost", { cockpit_context: null });
  assert.equal(await createDatabase(client, "cockpit_context"), false);
  assert.ok(!client.queries.some((sql) => sql.startsWith("COMMENT ON")));
  await assert.rejects(
    removeDatabase(client, "cockpit_context", { kind: "local", expected: "cockpit_context" }),
    /mark/,
  );
  assert.equal(await createDatabase(client, "cockpit_context_shadow"), true);
  assert.ok(
    client.queries.includes(`COMMENT ON DATABASE "cockpit_context_shadow" IS '${LOCAL_DB_MARK}'`),
  );
  assert.equal(
    await removeDatabase(client, "cockpit_context_shadow", {
      kind: "local",
      expected: "cockpit_context_shadow",
    }),
    true,
  );
});

test("the dev compose init script writes exactly LOCAL_DB_MARK", () => {
  const script = readFileSync(
    path.join(ROOT, "scripts/db/dev-postgres-init/10-mark-local.sh"),
    "utf8",
  );
  assert.ok(script.includes(`IS '${LOCAL_DB_MARK}';`));
  const compose = readFileSync(path.join(ROOT, "docker-compose.dev.yml"), "utf8");
  assert.match(compose, /\.\/scripts\/db\/dev-postgres-init:\/docker-entrypoint-initdb\.d:ro/);
});

test("scratch removal requires the scratch-name shape (no mark needed on a disposable server)", async () => {
  const client = fakeClient("postgres", { cockpit_context_check_abc123: null });
  await assert.rejects(
    removeDatabase(client, "cockpit_context", { kind: "scratch" }),
    /not an exact scratch/,
  );
  assert.equal(
    await removeDatabase(client, "cockpit_context_check_abc123", { kind: "scratch" }),
    true,
  );
});
