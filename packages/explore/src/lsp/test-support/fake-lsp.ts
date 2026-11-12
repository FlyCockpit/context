import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LspManager, type LspManagerOptions } from "../manager";
import { createLspSandbox, type LspSandbox } from "../sandbox";
import { LANGUAGE_SERVER_SPECS, type LanguageServerSpec, type LspLanguage } from "../specs";
import { buildLspTools } from "../tools";

/**
 * Test harness around `fake-lsp-server.mjs`: real child processes speaking
 * LSP, no real language server. Call `cleanupFakeLsp()` in `afterEach`.
 */
const FAKE_SERVER = path.resolve(import.meta.dirname, "fake-lsp-server.mjs");

const temps: string[] = [];
const managers: LspManager[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A checkout with one TypeScript and one Python file. */
function makeCheckout(): string {
  const root = tempDir("cockpit-context-lsp-checkout-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "greet.ts"),
    'export function greet(name: string): string {\n  const message = "hi " + name;\n  return message;\n}\n',
  );
  fs.writeFileSync(path.join(root, "src", "tool.py"), "def tool():\n    return 1\n");
  return root;
}

export type LogEntry = {
  pid: number;
  event: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export function readLog(logFile: string): LogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function fakeSpecs(env: Record<string, string>): Partial<Record<LspLanguage, LanguageServerSpec>> {
  const fake = (language: LspLanguage): LanguageServerSpec => ({
    ...LANGUAGE_SERVER_SPECS[language],
    command: () => ({
      command: process.execPath,
      args: [FAKE_SERVER, "--stdio"],
      env,
      readOnlyPaths: [FAKE_SERVER],
    }),
  });
  return { typescript: fake("typescript"), python: fake("python") };
}

const SILENT = { warn: () => {}, error: () => {} };

/** What `testSandbox` makes: a probe outcome, or `probing` (a probe that never settles). */
export type TestSandboxState =
  | { mode: "off" }
  | { mode: "probing" }
  | { mode: "landlock"; abi: number; tcp: boolean; scoping: boolean }
  | { mode: "unavailable"; reason: "missing" | "unsupported" | "failed"; detail: string };

/**
 * A sandbox for tests that never touches the Landlock helper: `off` (the
 * default) runs the fake server directly, as `COCKPIT_CONTEXT_LSP_SANDBOX=off` does but
 * without the warning; `unavailable` is a required sandbox whose probe failed
 * (settled synchronously); `probing` one whose probe is still running.
 */
export function testSandbox(state: TestSandboxState = { mode: "off" }): LspSandbox {
  if (state.mode === "off") return createLspSandbox({ mode: "off", logger: SILENT });
  if (state.mode === "probing") {
    return createLspSandbox({
      mode: "required",
      probe: () => new Promise<never>(() => {}),
      logger: SILENT,
    });
  }
  if (state.mode === "unavailable") {
    return createLspSandbox({
      mode: "required",
      probe: () => ({ ok: false, reason: state.reason, detail: state.detail }),
      logger: SILENT,
    });
  }
  const { abi, tcp, scoping } = state;
  return createLspSandbox({
    mode: "required",
    probe: () => ({ ok: true, abi, tcp, scoping }),
    logger: SILENT,
  });
}

export function setupFakeLsp(
  options: {
    mode?: string;
    manager?: LspManagerOptions;
    sandbox?: LspSandbox;
    /** Extra env for the fake server (e.g. FAKE_LSP_PROBE_PATHS). */
    env?: Record<string, string>;
  } = {},
) {
  const root = makeCheckout();
  const logDir = tempDir("cockpit-context-lsp-log-");
  const logFile = path.join(logDir, "log.jsonl");
  const manager = new LspManager({
    idleMs: 60_000,
    requestTimeoutMs: 5_000,
    startTimeoutMs: 5_000,
    sandbox: options.sandbox ?? testSandbox(),
    ...options.manager,
    specs: fakeSpecs({
      // Inside the sandbox nothing is writable: the fake cannot log there.
      FAKE_LSP_LOG: options.sandbox ? "" : logFile,
      FAKE_LSP_MODE: options.mode ?? "",
      FAKE_LSP_ERROR_PATH: root,
      FAKE_LSP_SYMBOL_URI: pathToFileURL(path.join(root, "src", "greet.ts")).href,
      ...options.env,
    }),
  });
  managers.push(manager);
  return { root, logFile, manager };
}

export async function callLspTool(
  manager: LspManager,
  root: string,
  name: string,
  input: Record<string, unknown>,
  checkoutId = "checkout-1",
): Promise<string> {
  // As a run does: the tools are built once the sandbox probe has settled.
  await manager.ready();
  const tool = buildLspTools({ manager, checkoutId, root }).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.execute(input, new AbortController().signal));
}

export async function cleanupFakeLsp(): Promise<void> {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
