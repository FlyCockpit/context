import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GIT_HARDENING_CONFIG,
  GIT_NO_NETWORK_CONFIG,
  GitCommandError,
  gitArgv,
  gitEnvironment,
  revParseCommit,
  runGit,
} from "./git-exec";
import { createFixtureRepo, type FixtureRepo, fixtureGit } from "./test-support/fixture-repo";

let root: string;
let fixture: FixtureRepo;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-git-exec-"));
  fixture = await createFixtureRepo(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gitArgv", () => {
  it("puts the hardening config, network config and --git-dir before the command", () => {
    const argv = gitArgv(["fetch", "origin"], {
      gitDir: "/data/repos/x.git",
      network: { config: ["http.curloptResolve=github.com:443:140.82.112.3"], env: {} },
    });
    const configs = argv.filter((_, index) => argv[index - 1] === "-c");
    expect(configs).toEqual([
      ...GIT_HARDENING_CONFIG,
      "http.curloptResolve=github.com:443:140.82.112.3",
    ]);
    expect(argv.slice(-3)).toEqual(["--git-dir=/data/repos/x.git", "fetch", "origin"]);
    for (const required of [
      "core.hooksPath=/dev/null",
      "protocol.allow=never",
      "protocol.https.allow=always",
      "protocol.ssh.allow=always",
      "submodule.recurse=false",
      "core.symlinks=true",
    ]) {
      expect(configs).toContain(required);
    }
    for (const denied of GIT_NO_NETWORK_CONFIG) expect(configs).not.toContain(denied);
  });

  it("denies the https and ssh transports, last, on a call without a network config", () => {
    const argv = gitArgv(["rev-parse", "HEAD"], { gitDir: "/data/repos/x.git" });
    const configs = argv.filter((_, index) => argv[index - 1] === "-c");
    expect(configs).toEqual([...GIT_HARDENING_CONFIG, ...GIT_NO_NETWORK_CONFIG]);
    expect(GIT_NO_NETWORK_CONFIG).toEqual([
      "protocol.https.allow=never",
      "protocol.ssh.allow=never",
    ]);
    // Last value wins: the denial comes after the hardening's "always".
    expect(configs.lastIndexOf("protocol.https.allow=never")).toBeGreaterThan(
      configs.indexOf("protocol.https.allow=always"),
    );
    expect(configs.lastIndexOf("protocol.ssh.allow=never")).toBeGreaterThan(
      configs.indexOf("protocol.ssh.allow=always"),
    );
  });
});

describe("gitEnvironment", () => {
  it("inherits nothing from the server environment but PATH", () => {
    process.env.COCKPIT_CONTEXT_TEST_SECRET = "do-not-leak";
    try {
      const env = gitEnvironment();
      expect(env.COCKPIT_CONTEXT_TEST_SECRET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_SSH_COMMAND: "false",
      });
    } finally {
      delete process.env.COCKPIT_CONTEXT_TEST_SECRET;
    }
  });

  it("lets a network config override the ssh command", () => {
    expect(gitEnvironment({ GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
  });
});

describe("runGit", () => {
  it("applies the hardening config to the real git", async () => {
    const { stdout } = await runGit(["config", "--get", "core.hooksPath"], {
      gitDir: fixture.bareDir,
    });
    expect(stdout.trim()).toBe("/dev/null");
  });

  it("refuses the file transport", async () => {
    await expect(
      runGit(["ls-remote", `file://${fixture.workDir}`], { gitDir: fixture.bareDir }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).stderr).toMatch(/transport 'file' not allowed/);
      return true;
    });
  });

  it("refuses the ext transport", async () => {
    await expect(
      runGit(["ls-remote", "ext::sh -c id"], { gitDir: fixture.bareDir }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  it("has no route to a remote without a network config", async () => {
    await expect(
      runGit(["ls-remote", "git@github.com:a/b"], { gitDir: fixture.bareDir, timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  it("kills git at the timeout", async () => {
    // `cat-file --batch` waits on stdin, which runGit never closes, so it
    // deterministically outlives the deadline.
    await expect(
      runGit(["cat-file", "--batch"], { gitDir: fixture.bareDir, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
  });

  it("caps output", async () => {
    await expect(
      runGit(["log", "--all", "-p"], { gitDir: fixture.bareDir, maxOutputBytes: 10 }),
    ).rejects.toMatchObject({
      code: "GIT_FAILED",
      message: "git log produced more output than allowed.",
    });
  });

  it("reports a non-zero exit with its code and stderr", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "refs/heads/nope"], { gitDir: fixture.bareDir }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GitCommandError);
      expect(error).toMatchObject({ code: "GIT_FAILED", exitCode: 128 });
      expect((error as GitCommandError).message).toMatch(/^git rev-parse failed: fatal:/);
      return true;
    });
  });

  it("resolves an exit code the caller accepts, with the full output", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], {
        gitDir: fixture.bareDir,
        okExitCodes: [1],
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 1 });
  });

  it("stops git when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      runGit(["cat-file", "--batch"], { gitDir: fixture.bareDir, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "GIT_FAILED", message: "git cat-file was aborted." });
    await expect(
      runGit(["status"], { gitDir: fixture.bareDir, signal: controller.signal }),
    ).rejects.toMatchObject({ message: "git status was aborted." });
  });

  it("refuses https without a network config, even when the remote is named directly", async () => {
    await expect(
      runGit(["ls-remote", "https://127.0.0.1:9/o/r"], { gitDir: fixture.bareDir }),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as GitCommandError).stderr).toMatch(/transport 'https' not allowed/);
      return true;
    });
  });

  it("makes a lazy fetch from the promisor remote fail closed without a network config", async () => {
    // A blobless clone whose promisor remote is https: reading a missing blob
    // would make git spawn `git fetch origin` itself, resolving the host on
    // its own. The denial reaches that child git through GIT_CONFIG_PARAMETERS.
    const partial = path.join(root, "partial.git");
    await fixtureGit(
      root,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--quiet",
      "--bare",
      "--filter=blob:none",
      `file://${fixture.workDir}`,
      partial,
    );
    await fixtureGit(partial, "config", "remote.origin.url", "https://127.0.0.1:9/o/r");
    await expect(
      runGit(["cat-file", "-p", `${fixture.shas.one}:README.md`], { gitDir: partial }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).stderr).toMatch(/transport 'https' not allowed/);
      return true;
    });
  });
});

/** True once `pid` is gone (polls: a killed orphan is reaped asynchronously). */
async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("runGit process group", () => {
  // A shell alias stands in for the helpers git spawns (git-remote-https,
  // ssh, a lazy fetch): a grandchild in git's process group.
  const aliasRun = (script: string) => [`-c`, `alias.helper=!sh -c '${script}'`, "helper"];

  it("kills the helpers git started when it times out", async () => {
    const pidFile = path.join(root, "timeout.pid");
    await expect(
      runGit(aliasRun(`sleep 30 & echo $! > ${pidFile}; wait`), {
        gitDir: fixture.bareDir,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await processGone(pid)).toBe(true);
  });

  it("leaves no helper running after git exits normally", async () => {
    const pidFile = path.join(root, "orphan.pid");
    await runGit(aliasRun(`sleep 30 > /dev/null 2>&1 < /dev/null & echo $! > ${pidFile}`), {
      gitDir: fixture.bareDir,
    });
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await processGone(pid)).toBe(true);
  });

  it("never signals git's group again once git has exited (its pid may be recycled)", async () => {
    // A straggler in its own session keeps git's stdout open: git exits, the
    // 'exit' sweep cannot reach it, and 'close' waits until the timeout fires.
    // It writes its pid only after setsid(), and git waits for that, so the
    // sweep never catches it still in git's group.
    const pidFile = path.join(root, "straggler.pid");
    const kill = vi.spyOn(process, "kill");
    try {
      const straggler = `setsid sh -c "echo \\$\\$ > ${pidFile}; exec sleep 5" &`;
      const awaitReady = `while [ ! -s ${pidFile} ]; do sleep 0.05; done`;
      await expect(
        runGit(aliasRun(`${straggler} ${awaitReady}`), {
          gitDir: fixture.bareDir,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
      const groupKills = kill.mock.calls.filter(([pid]) => pid < 0);
      // Only the sweep at exit; the timeout came after git was reaped.
      expect(groupKills).toHaveLength(1);
    } finally {
      kill.mockRestore();
      const straggler = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      if (straggler > 0) {
        try {
          process.kill(straggler, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe("revParseCommit", () => {
  it("returns the commit for a tag and null for a miss", async () => {
    await expect(revParseCommit(fixture.bareDir, "refs/tags/v1.0.0")).resolves.toBe(
      fixture.shas.one,
    );
    await expect(revParseCommit(fixture.bareDir, "refs/tags/nope")).resolves.toBeNull();
  });
});
