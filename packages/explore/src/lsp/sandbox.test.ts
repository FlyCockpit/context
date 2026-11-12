import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { LspManager } from "./manager";
import {
  buildLandlockArgs,
  createLspSandbox,
  createPrivateDir,
  findLandlockHelper,
  LANDLOCK_HELPER_DEV_PATH,
  LANDLOCK_HELPER_IMAGE_PATH,
  type LspSandboxStatus,
  type ProbeResult,
  probeLandlock,
} from "./sandbox";
import {
  callLspTool,
  cleanupFakeLsp,
  readLog,
  setupFakeLsp,
  tempDir,
} from "./test-support/fake-lsp";
import { realLandlockHelper } from "./test-support/landlock";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupFakeLsp();
  vi.restoreAllMocks();
});

const SILENT = { warn: () => {}, error: () => {} };

/** `[flag, path]` pairs of the helper's allowlist. */
function rules(args: string[]): Array<[string, string]> {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const found: Array<[string, string]> = [];
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index] as string;
    if (flag === "--ro" || flag === "--rx" || flag === "--rw") {
      found.push([flag, options[index + 1] as string]);
    }
  }
  return found;
}

/** A data dir with two checkouts and a key file, as `COCKPIT_CONTEXT_DATA_DIR` holds them. */
function dataDir() {
  const data = tempDir("cockpit-context-lsp-data-");
  const checkout = path.join(data, "checkouts", "mine");
  const other = path.join(data, "checkouts", "theirs");
  for (const dir of [path.join(checkout, "pkg"), other, path.join(data, "ssh")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(other, "private.ts"), "export const secret = 1;\n");
  fs.writeFileSync(path.join(data, "ssh", "id_ed25519"), "key\n");
  return { data, checkout, other };
}

/** A fake helper: a shell script standing in for cockpit-context-landlock. */
function fakeHelper(body: string): string {
  const dir = tempDir("cockpit-context-lsp-fake-helper-");
  const file = path.join(dir, "cockpit-context-landlock");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("buildLandlockArgs", () => {
  it("allows only the system dirs, the server's own files, the ONE checkout and the private dir", () => {
    const { data, checkout, other } = dataDir();
    const serverDir = tempDir("cockpit-context-lsp-server-");
    const privateDir = createPrivateDir(tempDir("cockpit-context-lsp-tmp-"));
    const args = buildLandlockArgs(
      {
        server: {
          command: process.execPath,
          args: ["server.js", "--stdio"],
          readOnlyPaths: [serverDir],
        },
        checkoutRoot: checkout,
        workspaceRoot: path.join(checkout, "pkg"),
      },
      privateDir,
      { PATH: path.join(privateDir, "bin"), HOME: path.join(privateDir, "home") },
    );
    const node = fs.realpathSync(process.execPath);
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1)).toEqual([node, "server.js", "--stdio"]);

    const allowed = rules(args);
    const expected = new Set([
      "--rx /usr",
      "--rx /lib",
      "--rx /lib32",
      "--rx /lib64",
      "--rx /libx32",
      "--ro /etc/ld.so.cache",
      `--rx ${node}`,
      `--ro ${serverDir}`,
      `--ro ${checkout}`,
      `--rw ${privateDir}`,
    ]);
    expect(allowed.map((rule) => rule.join(" ")).filter((rule) => !expected.has(rule))).toEqual([]);
    expect(allowed).toContainEqual(["--ro", checkout]);
    expect(allowed).toContainEqual(["--rw", privateDir]);
    expect(allowed.filter(([flag]) => flag === "--rw")).toEqual([["--rw", privateDir]]);
    // Nothing that holds the other checkout, the key file or the data dir itself.
    for (const [, allowedPath] of allowed) {
      for (const forbidden of [data, other, path.join(data, "ssh"), "/proc", "/etc", "/root"]) {
        expect(forbidden === allowedPath || forbidden.startsWith(`${allowedPath}/`)).toBe(false);
      }
    }
    expect(args.join(" ")).not.toContain(other);

    // Exactly the env given, and the workspace as cwd.
    const options = args.slice(0, separator);
    expect(
      options.filter((option) => option.startsWith("PATH=") || option.startsWith("HOME=")),
    ).toEqual([`PATH=${path.join(privateDir, "bin")}`, `HOME=${path.join(privateDir, "home")}`]);
    expect(options.filter((option) => option === "--env")).toHaveLength(2);
    expect(options.join(" ")).toContain(`--chdir ${path.join(checkout, "pkg")}`);
  });

  it("refuses a server path that contains the checkout (it would expose its siblings)", () => {
    const { data, checkout } = dataDir();
    const privateDir = createPrivateDir(tempDir("cockpit-context-lsp-tmp-"));
    expect(() =>
      buildLandlockArgs(
        {
          server: { command: process.execPath, args: [], readOnlyPaths: [data] },
          checkoutRoot: checkout,
          workspaceRoot: checkout,
        },
        privateDir,
        {},
      ),
    ).toThrow(/contains the checkout/);
  });

  it("refuses a checkout under a system directory (its siblings would be readable)", () => {
    expect(() =>
      buildLandlockArgs(
        {
          server: { command: process.execPath, args: [] },
          checkoutRoot: "/usr/local/cockpit-context-data/checkouts/x",
          workspaceRoot: "/usr/local/cockpit-context-data/checkouts/x",
        },
        createPrivateDir(tempDir("cockpit-context-lsp-tmp-")),
        {},
      ),
    ).toThrow(/system directory/);
  });

  it("refuses a workspace outside the checkout", () => {
    const { checkout, other } = dataDir();
    expect(() =>
      buildLandlockArgs(
        {
          server: { command: process.execPath, args: [] },
          checkoutRoot: checkout,
          workspaceRoot: other,
        },
        createPrivateDir(tempDir("cockpit-context-lsp-tmp-")),
        {},
      ),
    ).toThrow(/inside the checkout/);
  });
});

describe("findLandlockHelper", () => {
  it("in development, finds the build of `pnpm run lsp:build-sandbox` above the module", () => {
    const repo = tempDir("cockpit-context-lsp-repo-");
    const helper = path.join(repo, LANDLOCK_HELPER_DEV_PATH);
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
    const from = path.join(repo, "packages", "explore", "src", "lsp");
    fs.mkdirSync(from, { recursive: true });
    const found = findLandlockHelper({ production: false, from });
    expect(found === LANDLOCK_HELPER_IMAGE_PATH || found === helper).toBe(true);
  });

  it("in production, only the image's fixed path", () => {
    const repo = tempDir("cockpit-context-lsp-repo-");
    const helper = path.join(repo, LANDLOCK_HELPER_DEV_PATH);
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
    const found = findLandlockHelper({ production: true, from: repo });
    expect(found === undefined || found === LANDLOCK_HELPER_IMAGE_PATH).toBe(true);
  });
});

describe("createLspSandbox (fail closed)", () => {
  const request = () => {
    const { checkout } = dataDir();
    return {
      server: { command: process.execPath, args: [] },
      checkoutRoot: checkout,
      workspaceRoot: checkout,
    };
  };

  it("helper missing: probing first, then unavailable (missing), logged once, never launches", async () => {
    const error = vi.fn();
    const sandbox = createLspSandbox({
      mode: "required",
      helperPath: "/nonexistent/cockpit-context-landlock",
      logger: { warn: vi.fn(), error },
    });
    // Non-blocking: the first status starts the probe and reports it running.
    expect(sandbox.status()).toEqual({ mode: "probing", since: expect.any(String) });
    expect(() => sandbox.launch(request())).toThrow(/unavailable/);
    await expect(sandbox.ready()).resolves.toEqual({
      mode: "unavailable",
      reason: "missing",
      detail: "the Landlock helper is not installed (/nonexistent/cockpit-context-landlock)",
      checkedAt: expect.any(String),
    });
    expect(sandbox.status()).toMatchObject({ mode: "unavailable", reason: "missing" });
    expect(error).toHaveBeenCalledOnce();
    expect(() => sandbox.launch(request())).toThrow(/unavailable/);
    sandbox.dispose();
  });

  it("no Landlock in the kernel: unavailable (unsupported) with the helper's reason", async () => {
    const helper = fakeHelper(
      `echo '{"landlock":false,"abi":0,"reason":"Landlock is not enabled on this kernel"}'; exit 1`,
    );
    const sandbox = createLspSandbox({ mode: "required", helperPath: helper, logger: SILENT });
    await expect(sandbox.ready()).resolves.toEqual({
      mode: "unavailable",
      reason: "unsupported",
      detail: "Landlock is not enabled on this kernel",
      checkedAt: expect.any(String),
    });
    expect(() => sandbox.launch(request())).toThrow(/unavailable/);
    sandbox.dispose();
  });

  it("the helper fails the test launch: unavailable (failed) with a retry time, never launches", async () => {
    const helper = fakeHelper(
      [
        'if [ "$1" = "--probe" ]; then',
        `  echo '{"landlock":true,"abi":8,"filesystem":true,"tcp":true,"scoping":true,"enforced":true}'`,
        "  exit 0",
        "fi",
        'echo "cockpit-context-landlock: landlock_restrict_self: Operation not permitted (the command was not started)" >&2',
        "exit 125",
      ].join("\n"),
    );
    const sandbox = createLspSandbox({ mode: "required", helperPath: helper, logger: SILENT });
    const status = await sandbox.ready();
    expect(status).toEqual({
      mode: "unavailable",
      reason: "failed",
      detail:
        "cockpit-context-landlock: landlock_restrict_self: Operation not permitted (the command was not started)",
      checkedAt: expect.any(String),
      retryAt: expect.any(String),
    });
    expect(() => sandbox.launch(request())).toThrow(/unavailable/);
    sandbox.dispose();
  });

  it("a probe that reports an unenforced restriction: unavailable (failed)", async () => {
    const helper = fakeHelper(
      `echo '{"landlock":true,"abi":3,"filesystem":true,"tcp":false,"scoping":false,"enforced":false,"reason":"the restriction was not enforced"}'; exit 1`,
    );
    await expect(probeLandlock(helper)).resolves.toEqual({
      ok: false,
      reason: "failed",
      detail: "the restriction was not enforced",
    });
  });

  it("a helper that hangs is killed at the 15 s timeout: failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = fakeHelper("exec sleep 60");
    const result = probeLandlock(helper);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({
      ok: false,
      reason: "failed",
      detail: "the helper did not finish within 15 s",
    });
  });

  it("does not block: status() answers while the probe runs, and the tools stay off until it passes", async () => {
    let pass: (result: ProbeResult) => void = () => {};
    const sandbox = createLspSandbox({
      mode: "required",
      helperPath: process.execPath,
      probe: () =>
        new Promise<ProbeResult>((resolve) => {
          pass = resolve;
        }),
      logger: SILENT,
    });
    const manager = new LspManager({ sandbox });
    expect(manager.enabled).toBe(false);
    expect(manager.status().sandbox).toMatchObject({ mode: "probing" });
    const ready = manager.ready();
    pass({ ok: true, abi: 8, tcp: true, scoping: true });
    await expect(ready).resolves.toMatchObject({
      enabled: true,
      sandbox: { mode: "landlock", abi: 8, checkedAt: expect.any(String) },
    });
    await manager.dispose();
  });

  describe("re-probing", () => {
    const FAILED: ProbeResult = { ok: false, reason: "failed", detail: "transient" };
    const PASSED: ProbeResult = { ok: true, abi: 8, tcp: true, scoping: true };
    const delayOf = (status: LspSandboxStatus) =>
      status.mode === "unavailable" && status.retryAt
        ? Date.parse(status.retryAt) - Date.parse(status.checkedAt)
        : undefined;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a helper self-test failure with a valid ABI through the backoff and recovers", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const helper = fakeHelper(
        `echo '{"landlock":false,"abi":8,"reason":"fork failed: Resource temporarily unavailable"}'; exit 1`,
      );
      // Exercise the real response classifier, not a preclassified failed result.
      const probe = vi.fn(() => probeLandlock(helper));
      const sandbox = createLspSandbox({
        mode: "required",
        helperPath: helper,
        probe,
        logger: SILENT,
      });
      try {
        for (const [index, delay] of [30_000, 120_000, 600_000, 600_000].entries()) {
          const status = await sandbox.ready();
          expect(status).toMatchObject({
            mode: "unavailable",
            reason: "failed",
            detail: "fork failed: Resource temporarily unavailable",
          });
          expect(delayOf(status)).toBe(delay);
          expect(() => sandbox.launch(request())).toThrow(/unavailable/);
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(probe).toHaveBeenCalledTimes(index + 1);
          if (index === 3) {
            fs.writeFileSync(
              helper,
              `#!/bin/sh\nif [ "$1" = "--probe" ]; then\n  echo '{"landlock":true,"abi":8,"tcp":true,"scoping":true,"enforced":true}'\nfi\nexit 0\n`,
            );
          }
          await vi.advanceTimersByTimeAsync(1);
          expect(probe).toHaveBeenCalledTimes(index + 2);
        }
        await expect(sandbox.ready()).resolves.toMatchObject({ mode: "landlock", abi: 8 });
        const launch = sandbox.launch(request());
        expect(launch.command).toBe(helper);
        launch.cleanup();
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(probe).toHaveBeenCalledTimes(5);
      } finally {
        sandbox.dispose();
      }
    });

    it("retries a failed probe after 30 s, 2 min, 10 min, then every 10 min, until it passes", async () => {
      vi.useFakeTimers();
      const outcomes = [FAILED, FAILED, FAILED, FAILED, PASSED];
      const probe = vi.fn(async () => outcomes.shift() ?? PASSED);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const sandbox = createLspSandbox({
        mode: "required",
        helperPath: process.execPath,
        probe,
        logger,
      });
      const delays = [delayOf(await sandbox.ready())];
      for (const wait of [30_000, 120_000, 600_000]) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(probe).toHaveBeenCalledTimes(delays.length);
        await vi.advanceTimersByTimeAsync(1);
        expect(probe).toHaveBeenCalledTimes(delays.length + 1);
        delays.push(delayOf(sandbox.status()));
      }
      expect(delays).toEqual([30_000, 120_000, 600_000, 600_000]);
      expect(logger.error.mock.calls[0]?.[0]).toContain("Probing again in 30 s");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(probe).toHaveBeenCalledTimes(5);
      expect(sandbox.status()).toMatchObject({ mode: "landlock", abi: 8 });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("after 4 failed attempts"));
      // A pass is cached: no further probes.
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(probe).toHaveBeenCalledTimes(5);
      sandbox.dispose();
    });

    it.each([
      ["missing", { ok: false, reason: "missing", detail: "no helper" }],
      ["unsupported", { ok: false, reason: "unsupported", detail: "no Landlock" }],
    ] as const)("caches %s: never probed again", async (_name, outcome) => {
      vi.useFakeTimers();
      const probe = vi.fn(async (): Promise<ProbeResult> => outcome);
      const sandbox = createLspSandbox({ mode: "required", probe, logger: SILENT });
      const status = await sandbox.ready();
      expect(status).toMatchObject({ mode: "unavailable", reason: outcome.reason });
      expect(status).not.toHaveProperty("retryAt");
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(probe).toHaveBeenCalledOnce();
      sandbox.dispose();
    });

    it("a probe that throws counts as failed and is retried", async () => {
      vi.useFakeTimers();
      const probe = vi
        .fn<() => Promise<ProbeResult>>()
        .mockRejectedValueOnce(new Error("EAGAIN"))
        .mockResolvedValue(PASSED);
      const sandbox = createLspSandbox({
        mode: "required",
        helperPath: process.execPath,
        probe,
        logger: SILENT,
      });
      await expect(sandbox.ready()).resolves.toMatchObject({
        mode: "unavailable",
        reason: "failed",
        detail: "EAGAIN",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sandbox.status()).toMatchObject({ mode: "landlock" });
      sandbox.dispose();
    });

    it("reports an in-flight retry and preserves the last completed probe time", async () => {
      vi.useFakeTimers();
      let finish!: (result: ProbeResult) => void;
      const probe = vi
        .fn<() => Promise<ProbeResult>>()
        .mockResolvedValueOnce(FAILED)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      const sandbox = createLspSandbox({ mode: "required", probe, logger: SILENT });
      const first = await sandbox.ready();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sandbox.status()).toEqual({
        mode: "probing",
        since: new Date().toISOString(),
        checkedAt: "checkedAt" in first ? first.checkedAt : undefined,
      });
      expect(() => sandbox.launch(request())).toThrow(/unavailable/);
      finish(PASSED);
      await sandbox.ready();
      expect(sandbox.status()).toMatchObject({
        mode: "landlock",
        checkedAt: new Date().toISOString(),
      });
      sandbox.dispose();
    });

    it("dispose cancels a scheduled retry", async () => {
      vi.useFakeTimers();
      const probe = vi.fn(async () => FAILED);
      const sandbox = createLspSandbox({ mode: "required", probe, logger: SILENT });
      await sandbox.ready();
      sandbox.dispose();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(probe).toHaveBeenCalledOnce();
    });

    it("concurrent ready() calls share one probe", async () => {
      const probe = vi.fn(async () => PASSED);
      const sandbox = createLspSandbox({ mode: "required", probe, logger: SILENT });
      const [a, b] = await Promise.all([sandbox.ready(), sandbox.ready()]);
      expect(a).toBe(b);
      expect(probe).toHaveBeenCalledOnce();
      sandbox.dispose();
    });
  });

  it("the helper exits non-zero when a server starts: a tool error, the server never runs", async () => {
    const helper = fakeHelper(
      'echo "cockpit-context-landlock: cannot open /x: No such file or directory (the command was not started)" >&2; exit 125',
    );
    const sandbox = createLspSandbox({
      mode: "required",
      helperPath: helper,
      probe: () => ({ ok: true, abi: 8, tcp: true, scoping: true }),
      logger: SILENT,
    });
    const { root, manager, logFile } = setupFakeLsp({ sandbox });
    await expect(
      callLspTool(manager, root, "lsp_hover", { path: "src/greet.ts", line: 1, column: 17 }),
    ).rejects.toThrow(/lsp_hover failed: the language server is unavailable/);
    expect(readLog(logFile)).toEqual([]);
  });

  it("off: warns once, runs the server directly with a minimal env and a private dir", () => {
    const warn = vi.fn();
    const sandbox = createLspSandbox({ mode: "off", logger: { warn, error: vi.fn() } });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("WITHOUT the Landlock sandbox");
    expect(sandbox.status()).toEqual({ mode: "off" });
    const launch = sandbox.launch({
      server: { command: process.execPath, args: ["a"], env: { EXTRA: "1" } },
      checkoutRoot: "/x",
      workspaceRoot: "/x/pkg",
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.cwd).toBe("/x/pkg");
    expect(Object.keys(launch.env).sort()).toEqual([
      "EXTRA",
      "HOME",
      "LANG",
      "OPENSSL_CONF",
      "PATH",
      "TMPDIR",
    ]);
    const privateDir = path.dirname(launch.env.HOME as string);
    expect(fs.existsSync(privateDir)).toBe(true);
    launch.cleanup();
    expect(fs.existsSync(privateDir)).toBe(false);
    sandbox.dispose();
  });
});

/**
 * The REAL helper on this host (compiled with the host's cc). SKIPPED, with
 * the reason, where there is no compiler or the kernel has no Landlock.
 */
const real = await realLandlockHelper();
if (real.skip) console.warn(`[sandbox.test] Landlock integration tests skipped: ${real.skip}`);

describe.skipIf(Boolean(real.skip))("the real cockpit-context-landlock helper", () => {
  const helper = "helper" in real ? real.helper : "";

  it("fails closed: relative or unopenable paths never run the command", () => {
    const dir = tempDir("cockpit-context-lsp-failclosed-");
    const marker = path.join(dir, "ran");
    for (const rule of [
      ["--ro", "relative/path"],
      ["--ro", path.join(dir, "missing")],
    ]) {
      const result = spawnSync(helper, [...rule, "--rw", dir, "--", "/usr/bin/touch", marker], {
        encoding: "utf8",
      });
      expect(result.status).toBe(125);
      expect(result.stderr).toMatch(/^cockpit-context-landlock: .*\(the command was not started\)/);
      expect(fs.existsSync(marker)).toBe(false);
    }
    const relativeCommand = spawnSync(helper, ["--rx", "/usr", "--", "touch", marker], {
      encoding: "utf8",
    });
    expect(relativeCommand.status).toBe(125);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("--probe reports the ABI and the active protections", () => {
    const result = spawnSync(helper, ["--probe"], { encoding: "utf8" });
    const probe = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(probe).toMatchObject({ landlock: true, filesystem: true, enforced: true });
    expect(probe.tcp).toBe((probe.abi as number) >= 4);
    expect(probe.scoping).toBe((probe.abi as number) >= 6);
  });

  it("a server sees the checkout, a minimal env, and nothing else of the host", async () => {
    // Another checkout under the same data dir, the app's own source, the
    // app's environment.
    const { other } = dataDir();
    const secret = path.join(other, "private.ts");
    const appSource = path.resolve(import.meta.dirname, "sandbox.ts");
    const { root, manager } = setupFakeLsp({
      mode: "introspect",
      sandbox: createLspSandbox({ mode: "required", helperPath: helper, logger: SILENT }),
      env: {
        FAKE_LSP_PROBE_PATHS: [
          "src/greet.ts",
          secret,
          appSource,
          "/etc/passwd",
          `/proc/${process.pid}/environ`,
          "/proc/1/environ",
        ].join(":"),
      },
    });
    const output = await callLspTool(manager, root, "lsp_hover", {
      path: "src/greet.ts",
      line: 1,
      column: 17,
    });
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const seen = JSON.parse(json) as {
      cwd: string;
      envKeys: string[];
      rootUri: string;
      uri: string;
      readable: Record<string, boolean>;
    };
    // Real paths (no mount namespace), redacted to "." before the model sees them.
    expect(seen.cwd).toBe(".");
    expect(seen.rootUri).toBe(".");
    expect(seen.uri).toBe("./src/greet.ts");
    expect(output).not.toContain(root);
    expect(seen.envKeys.filter((key) => !key.startsWith("FAKE_LSP_"))).toEqual([
      "HOME",
      "LANG",
      "OPENSSL_CONF",
      "PATH",
      "TMPDIR",
    ]);
    expect(seen.readable).toEqual({
      "src/greet.ts": true,
      [secret]: false,
      [appSource]: false,
      "/etc/passwd": false,
      [`/proc/${process.pid}/environ`]: false,
      "/proc/1/environ": false,
    });
  }, 30_000);

  it.skipIf("tcp" in real && !real.tcp)("denies TCP connections (Landlock ABI 4+)", async () => {
    const net = await import("node:net");
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { checkout } = dataDir();
      const privateDir = createPrivateDir(tempDir("cockpit-context-lsp-tmp-"));
      const script = `require("node:net").connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", (e) => { console.log(e.code); process.exit(7); });`;
      const args = buildLandlockArgs(
        {
          server: { command: process.execPath, args: ["-e", script] },
          checkoutRoot: checkout,
          workspaceRoot: checkout,
        },
        privateDir,
        { OPENSSL_CONF: path.join(privateDir, "openssl.cnf") },
      );
      const result = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = spawn(helper, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("close", (status) => resolve({ status, stdout }));
      });
      expect(result).toEqual({ status: 7, stdout: "EACCES\n" });
    } finally {
      server.close();
    }
  });
});
