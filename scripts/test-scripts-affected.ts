/**
 * `pnpm test:scripts:affected`, in `pnpm verify:fast`: runs the root script
 * suites (`db:test-unit`, `backup:test-unit`, `deploy:test-unit`) whose inputs
 * this branch or the work tree changed. `pnpm verify` and CI (pr-checks.yml)
 * always run all three.
 *
 * Fails open: every path is classified by RULES below, and a path no rule
 * names, a shared input (root package.json, the lockfile, the Node version,
 * scripts/lib/, this selector) or an unknown base branch runs all three. Only
 * paths a rule proves the suites never read are skipped.
 *
 * The inputs were taken from the suites themselves (every repo file they open,
 * stat, list or execute, recorded with `strace -f -e trace=%file`), not from
 * reading the code: scripts/db/**, scripts/backup/pre-migrate.sh (the db
 * runtime test runs the real hook), packages/db/prisma/migrations/** and
 * docker-compose.dev.yml for db; scripts/backup/**, scripts/backup-heartbeat.mjs,
 * scripts/db/lib/** and the root package.json for backup (and, off Linux, the
 * Dockerfile's base image: scripts/backup/linux-only.mjs); the build-commit,
 * deploy-check and docker-entrypoint scripts for deploy; plus node_modules
 * (the lockfile).
 * When a suite starts reading something new, add it to its rule. The test
 * (`pnpm test:scripts:affected:test`, in `pnpm verify:tooling`) fails while
 * any tracked or untracked file is unclassified, a suite's own test files
 * would not select it, or a file its tests reach by a relative import or
 * `new URL(…, import.meta.url)` would not. A read by any other means (a path
 * built from strings, a glob, a spawned script's own reads) is only seen by
 * re-tracing the suites.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const SUITES = ["db", "backup", "deploy"] as const;
export type Suite = (typeof SUITES)[number];

/** The package.json script each suite runs. */
export const SUITE_SCRIPTS: Record<Suite, string> = {
  db: "db:test-unit",
  backup: "backup:test-unit",
  deploy: "deploy:test-unit",
};

/**
 * A rule matches a path exactly, or by prefix when it ends in "/" or ".".
 * First match wins, so the narrower rules come first.
 */
interface Rule {
  paths: readonly string[];
  suites: readonly Suite[] | "all";
}

const OWN_SELECTOR = ["scripts/test-scripts-affected.ts", "scripts/test-scripts-affected.test.ts"];

export const RULES: readonly Rule[] = [
  // Shared inputs: dependencies, the Node version, shared helpers, this selector.
  {
    paths: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".nvmrc", ".npmrc"],
    suites: "all",
  },
  { paths: ["scripts/lib/", ...OWN_SELECTOR], suites: "all" },
  // What each suite reads.
  { paths: ["scripts/db/lib/", "scripts/backup/pre-migrate.sh"], suites: ["db", "backup"] },
  {
    paths: [
      "scripts/db/",
      "packages/db/prisma/migrations/",
      "packages/db/prisma/schema/",
      "packages/db/prisma/fixtures/",
      "docker-compose.dev.yml",
    ],
    suites: ["db"],
  },
  // Off Linux, backup's host.sh / pre-migrate.sh tests run inside the
  // Dockerfile's first FROM image (scripts/backup/linux-only.mjs), a branch
  // a trace on Linux cannot see.
  { paths: ["scripts/backup/", "scripts/backup-heartbeat.mjs", "Dockerfile"], suites: ["backup"] },
  {
    paths: ["scripts/build-commit.", "scripts/deploy-check.", "scripts/docker-entrypoint."],
    suites: ["deploy"],
  },
  // Never read by the three suites. Files under scripts/ are named one by
  // one, so a new script is unclassified (runs everything) until it is added.
  {
    paths: [
      "apps/",
      "packages/",
      "docs/",
      "tools/",
      ".github/",
      "scripts/claude-hooks/",
      "scripts/fixtures/",
      "scripts/access-matrix-pre-notes-baseline.json",
      "scripts/assert-local-database.sh",
      "scripts/build-landlock-helper.mjs",
      "scripts/check-access-matrix.ts",
      "scripts/check-agent-rules.ts",
      "scripts/check-agents-size.ts",
      "scripts/check-destructive-operations.mjs",
      "scripts/check-doc-citations.ts",
      "scripts/check-docker-copy.ts",
      "scripts/check-load-dotenv-contract.ts",
      "scripts/check-prisma-query-cast-policy.ts",
      "scripts/check-release-age-excludes.ts",
      "scripts/check-runtime-tools.mjs",
      "scripts/check-template-secret-patterns.mjs",
      "scripts/check-test-colocation.ts",
      "scripts/compose.sh",
      "scripts/demo-run.ts",
      "scripts/dev-docker-down.sh",
      "scripts/dev-docker-logs.sh",
      "scripts/dev-docker.sh",
      "scripts/dev-tunnel.sh",
      "scripts/doctor.ts",
      "scripts/eval-explore-agent.ts",
      "scripts/fake-openrouter.ts",
      "scripts/filter-trufflehog-results.mjs",
      "scripts/find-free-port.sh",
      "scripts/generate-secrets.ts",
      "scripts/install-claude-hooks.ts",
      "scripts/install-pnpm.mjs",
      "scripts/policy-checks.sh",
      "scripts/setup.ts",
      "scripts/smoke-explore-agent.ts",
      "scripts/smoke-lsp.ts",
      "scripts/sync-agent-docs.ts",
      "scripts/sync-env-example.ts",
      "scripts/test-dokploy-deployment.mjs",
      "scripts/test-install-claude-hooks.ts",
      "scripts/test-io-guard.ts",
      "scripts/test-prisma-query-cast-policy.ts",
      "scripts/test-runtime-operations.mjs",
      "scripts/translate-locale-bundles.ts",
      "scripts/trufflehog-pr-scan.sh",
      "scripts/verify-dokploy-deployment.mjs",
      "scripts/vitest-test-io-guard-fixture.config.ts",
      ".cursorrules",
      ".dockerignore",
      ".editorconfig",
      ".env.docker.defaults",
      ".env.example",
      ".gitattributes",
      ".gitignore",
      ".oxlintrc.json",
      "AGENTS.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "Dockerfile.dev",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "THIRD-PARTY-LICENSES.md",
      "biome.json",
      "compose.backup.yaml",
      "compose.vps.yaml",
      "compose.yaml",
      "docker-compose.agent.yml",
      "doctor.config.jsonc",
      "knip.jsonc",
      "lefthook.yml",
      "portless.json",
      "sitemap.md",
      "tsconfig.json",
      "tsconfig.scripts.json",
      "turbo.json",
      "vitest.config.ts",
    ],
    suites: [],
  },
];

function matches(rulePath: string, path: string): boolean {
  return rulePath.endsWith("/") || rulePath.endsWith(".")
    ? path.startsWith(rulePath)
    : path === rulePath;
}

/** The rule for `path`, or undefined when no rule names it (runs everything). */
export function ruleFor(path: string): Rule | undefined {
  return RULES.find((rule) => rule.paths.some((rulePath) => matches(rulePath, path)));
}

/** Each suite to run, with the first path that selects it. */
export function selectSuites(changed: readonly string[] | undefined): Map<Suite, string> {
  const selected = new Map<Suite, string>();
  const all = (reason: string) => new Map(SUITES.map((suite) => [suite, reason]));
  if (changed === undefined) return all("the base branch was not found");
  for (const path of changed) {
    const rule = ruleFor(path);
    if (rule === undefined) {
      return all(`${path} changed, and no rule in scripts/test-scripts-affected.ts names it`);
    }
    if (rule.suites === "all") return all(`${path} changed (a shared input)`);
    for (const suite of rule.suites)
      if (!selected.has(suite)) selected.set(suite, `${path} changed`);
  }
  return selected;
}

/** Compared in order; the first that resolves is the base. */
export const BASE_REFS = ["origin/main", "main"] as const;

type Git = (args: readonly string[]) => string | undefined;

const runGit: Git = (args) => {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
};

/**
 * Files changed since the merge base with the default branch: commits, staged
 * and unstaged edits, and untracked files; a rename lists both of its paths.
 * undefined when unknown.
 */
export function changedFiles(git: Git = runGit): string[] | undefined {
  let base: string | undefined;
  for (const ref of BASE_REFS) {
    base = git(["merge-base", "HEAD", ref])?.trim();
    if (base) break;
  }
  if (!base) return undefined;
  const diff = git(["diff", "--name-only", "--no-renames", base]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (diff === undefined || untracked === undefined) return undefined;
  return [...diff.split("\n"), ...untracked.split("\n")].filter(Boolean);
}

// Node without import.meta.main (added in 24.2 and 22.18) would run this CLI as a
// silent no-op that exits 0, so refuse instead (use the Node version in .nvmrc).
if (typeof import.meta.main !== "boolean") {
  process.stderr.write("test-scripts-affected: Node 26 (.nvmrc) is required\n");
  process.exit(1);
}
if (import.meta.main) {
  try {
    parseArgs({ args: process.argv.slice(2), strict: true, options: {} });
  } catch (error) {
    process.stderr.write(
      `test-scripts-affected: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  const selected = selectSuites(changedFiles());
  for (const suite of SUITES) {
    const reason = selected.get(suite);
    const script = SUITE_SCRIPTS[suite];
    if (reason === undefined) {
      process.stdout.write(
        `${script} skipped: nothing it reads changed (CI and \`pnpm verify\` run it).\n`,
      );
      continue;
    }
    process.stdout.write(`${script} runs: ${reason}.\n`);
    const result = spawnSync("pnpm", ["run", script], { cwd: ROOT, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
