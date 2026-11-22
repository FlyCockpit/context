import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  describeUrl,
  isLocalHost,
  localDatabaseNames,
  shadowName,
  withDatabase,
  worktreeName,
} from "./local-db-name.mjs";

// A git hook (or any caller) may export GIT_DIR, GIT_INDEX_FILE and the like;
// inherited by the scratch directory's git calls (in local-db-name.mjs), they
// would point at the caller's repository. Drop every GIT_* variable, stop
// discovery at the temp dir, and turn hooks off for every git call in this
// process and its children (a global core.hooksPath must not judge these repos;
// `git init` and `git add` run hooks too).
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";

test("main and linked worktree names use the exact git directory without git writes", () => {
  const gitRead = (cwd, args) => (args.includes("--git-common-dir") ? "/main/.git" : `${cwd}/.git`);
  const main = localDatabaseNames({ cwd: "/main", env: {}, gitRead });
  assert.deepEqual(
    [main.main, main.shadow, main.worktree],
    ["cockpit_context", "cockpit_context_shadow", false],
  );
  assert.equal(
    localDatabaseNames({ cwd: "/main", env: { EXPECTED_DB: "myapp" }, gitRead }).main,
    "myapp",
  );
  const wt = localDatabaseNames({ cwd: "/wt", env: { EXPECTED_DB: "myapp" }, gitRead });
  assert.match(wt.main, /^cockpit_context_wt_[0-9a-f]{10}$/);
  assert.equal(wt.shadow, `${wt.main}_shadow`);
  assert.equal(wt.worktree, true);
  assert.equal(localDatabaseNames({ cwd: "/wt", env: {}, gitRead }).main, wt.main);
  assert.ok(wt.shadow.length < 63);
});

test("outside git behaves as the main checkout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbname-nogit-"));
  try {
    assert.equal(localDatabaseNames({ cwd: dir, env: {} }).main, "cockpit_context");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helpers", () => {
  assert.notEqual(worktreeName("/a/.git/worktrees/x"), worktreeName("/b/.git/worktrees/x"));
  assert.equal(shadowName("cockpit_context"), "cockpit_context_shadow");
  assert.equal(
    describeUrl(withDatabase("postgresql://u:p@[::1]:5433/cockpit_context", "x")).database,
    "x",
  );
  assert.deepEqual(describeUrl("postgresql://u:p@[::1]/s"), {
    host: "::1",
    port: "5432",
    database: "s",
  });
  assert.equal(isLocalHost("host.docker.internal"), false);
});
