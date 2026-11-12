import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLspSandbox } from "./sandbox";
import { runLspSandboxCheck } from "./sandbox-check";
import { cleanupFakeLsp, tempDir } from "./test-support/fake-lsp";
import { realLandlockHelper } from "./test-support/landlock";

afterEach(async () => {
  await cleanupFakeLsp();
});

/** A COCKPIT_CONTEXT_DATA_DIR-shaped work dir: a real checkout, a bare clone's HEAD, tmp/ (no ssh/). */
function dataDir() {
  const root = tempDir("cockpit-context-lsp-workdir-");
  const checkout = path.join(root, "checkouts", "repo00000001", "a".repeat(40));
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "src", "index.ts"), "export const other = 1;\n");
  fs.mkdirSync(path.join(root, "repos", "repo00000001.git"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos", "repo00000001.git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, "tmp"));
  return root;
}

const WORK_DIR_PROBES = [
  "the work dir's checkouts/ listing",
  "the work dir's repos/ listing",
  "the work dir's tmp/ listing",
  `a real checkout's file (checkouts/repo00000001/${"a".repeat(40)}/src/index.ts)`,
  "a real bare clone's file (repos/repo00000001.git/HEAD)",
];

/**
 * Real language servers (TypeScript 7, pyright) against the hostile fixture,
 * under the REAL Landlock helper (compiled with the host's cc).
 *
 * SKIPPED, with the reason, where there is no C compiler or the kernel has no
 * Landlock. The same check runs inside the production image:
 *   docker compose exec app node apps/server/dist/lsp-sandbox-check.mjs
 */
const real = await realLandlockHelper();
if (real.skip) console.warn(`[sandbox-check.test] skipped: ${real.skip}`);
const SILENT = { warn: vi.fn(), error: vi.fn() };

describe.skipIf(Boolean(real.skip))("runLspSandboxCheck (real servers under Landlock)", () => {
  const helper = "helper" in real ? real.helper : "";

  it("nothing outside the checkout reaches a tool output or the server process", async () => {
    const workDir = dataDir();
    const result = await runLspSandboxCheck({
      sandbox: createLspSandbox({ mode: "required", helperPath: helper, logger: SILENT }),
      workDir,
    });
    expect(result.sandbox).toMatchObject({ mode: "landlock" });
    expect(result.toolsOffered).toBe(true);
    expect(result.calls.length).toBeGreaterThan(20);
    // Every channel was exercised, diagnostics included.
    expect(new Set(result.calls.map((call) => call.tool))).toEqual(
      new Set([
        "diagnostics",
        "lsp_hover",
        "lsp_definition",
        "lsp_references",
        "lsp_document_symbols",
        "lsp_workspace_symbols",
      ]),
    );
    expect(result.calls.filter((call) => call.leaked)).toEqual([]);
    // Every hostile access was denied from inside the sandbox.
    const denied = result.probes.filter((probe) => probe.mustDeny);
    expect(denied.map((probe) => probe.name)).toEqual(
      expect.arrayContaining([
        "another checkout's file",
        "the fixture's parent directory listing (holds both checkouts)",
        `the work dir's listing (${fs.realpathSync(workDir)})`,
        ...WORK_DIR_PROBES,
        "a symlink in the checkout pointing outside",
        "/proc/1/environ",
        "the app's environment (/proc/<app pid>/environ)",
        "/etc/passwd",
        ...("tcp" in real && real.tcp ? ["TCP connect to 127.0.0.1"] : []),
      ]),
    );
    expect(denied.filter((probe) => probe.allowed)).toEqual([]);
    // Honest about what was not there to probe.
    expect(result.skipped).toEqual([`ssh/ (not present in ${fs.realpathSync(workDir)})`]);
    expect(result.leaked).toBe(false);
    // The servers still work inside the sandbox, and so does the checkout.
    expect(result.working.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "probe: a file in the checkout", ok: true },
      { name: "probe: the private HOME", ok: true },
      { name: "TypeScript definition inside the checkout", ok: true },
      { name: "TypeScript hover inside the checkout", ok: true },
      { name: "Python definition inside the checkout", ok: true },
      { name: "Python hover inside the checkout", ok: true },
    ]);
  }, 180_000);

  it("control: unsandboxed, the same fixture and probes leak", async () => {
    const result = await runLspSandboxCheck({
      sandbox: createLspSandbox({ mode: "off", logger: SILENT }),
      workDir: dataDir(),
    });
    const leaked = new Set(
      result.calls.filter((call) => call.leaked).map((call) => `${call.tool} ${call.input.path}`),
    );
    expect(leaked).toContain("lsp_hover src/main.ts");
    expect(leaked).toContain("lsp_hover app/main.py");
    expect(leaked).toContain("diagnostics app/main.py");
    // Everything the check process itself can reach, the unsandboxed server reaches too.
    const missed = result.probes.filter(
      (probe) => probe.mustDeny && probe.reachable && !probe.allowed,
    );
    expect(missed).toEqual([]);
    for (const name of WORK_DIR_PROBES) {
      expect(result.probes.find((probe) => probe.name === name)).toMatchObject({ allowed: true });
    }
    expect(
      result.probes.find((probe) => probe.name.startsWith("the app's environment")),
    ).toMatchObject({
      allowed: true,
    });
  }, 180_000);
});

describe("runLspSandboxCheck with COCKPIT_CONTEXT_LSP_SANDBOX=required and no helper", () => {
  it("offers no LSP tools and never runs a server unsandboxed", async () => {
    const error = vi.fn();
    const sandbox = createLspSandbox({
      mode: "required",
      helperPath: "/nonexistent/cockpit-context-landlock",
      logger: { warn: vi.fn(), error },
    });
    const result = await runLspSandboxCheck({ sandbox });
    expect(result.sandbox).toEqual({
      mode: "unavailable",
      reason: "missing",
      detail: "the Landlock helper is not installed (/nonexistent/cockpit-context-landlock)",
      checkedAt: expect.any(String),
    });
    expect(result.toolsOffered).toBe(false);
    expect(result.calls).toEqual([]);
    expect(result.probes).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
