import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Test-only helpers that build real git repositories in a temp dir with the
 * system git, isolated from the developer's git config (no signing, no
 * hooks, fixed identity and dates). Never imported by production code.
 */

const exec = promisify(execFile);

const FIXTURE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export async function fixtureGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: FIXTURE_ENV });
  return stdout.trim();
}

export interface FixtureRepo {
  /** Non-bare working repository (the "remote"). */
  workDir: string;
  /** Bare clone with Cockpit Context's refspec — what the git layer operates on. */
  bareDir: string;
  shas: {
    one: string;
    two: string;
    feature: string;
    four: string;
  };
}

async function commit(
  workDir: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await mkdir(path.dirname(path.join(workDir, file)), { recursive: true });
  await writeFile(path.join(workDir, file), content);
  await fixtureGit(workDir, "add", "--", file);
  await fixtureGit(workDir, "commit", "--quiet", "-m", message);
  return fixtureGit(workDir, "rev-parse", "HEAD");
}

/**
 * History:
 *   one   (main)  tags: v1.0.0 (annotated), 1.1.0
 *   two   (main)  tags: @scope/pkg@2.0.0, pkg-v2.1.0, react-query@3.0.0,
 *                       release-4.0.0, v5.0.0-beta.1, v1.2.0
 *   feature (branch "feature", off two)
 *   four  (main)
 */
export async function createFixtureRepo(root: string): Promise<FixtureRepo> {
  const workDir = path.join(root, "work");
  const bareDir = path.join(root, "bare.git");
  await mkdir(workDir, { recursive: true });
  await fixtureGit(workDir, "init", "--quiet", "-b", "main");
  // Let file:// clones honour --filter=blob:none, so tests exercise the
  // partial clone and the lazy blob fetch a worktree add triggers.
  await fixtureGit(workDir, "config", "uploadpack.allowFilter", "true");
  const one = await commit(workDir, "README.md", "# fixture\n", "one");
  await fixtureGit(workDir, "tag", "-a", "-m", "v1.0.0", "v1.0.0");
  await fixtureGit(workDir, "tag", "1.1.0");
  const two = await commit(workDir, "packages/pkg/index.ts", "export const two = 2;\n", "two");
  for (const tag of [
    "@scope/pkg@2.0.0",
    "pkg-v2.1.0",
    "react-query@3.0.0",
    "release-4.0.0",
    "v5.0.0-beta.1",
    "v1.2.0",
  ]) {
    await fixtureGit(workDir, "tag", tag);
  }
  await fixtureGit(workDir, "checkout", "--quiet", "-b", "feature");
  const feature = await commit(workDir, "feature.txt", "feature\n", "feature");
  await fixtureGit(workDir, "checkout", "--quiet", "main");
  const four = await commit(workDir, "src/four.ts", "export const four = 4;\n", "four");
  await fixtureGit(root, "clone", "--quiet", "--bare", workDir, bareDir);
  await fixtureGit(bareDir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
  return { workDir, bareDir, shas: { one, two, feature, four } };
}
