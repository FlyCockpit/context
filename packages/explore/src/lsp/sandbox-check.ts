import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DocumentDiagnosticRequest } from "vscode-languageserver-protocol/node";

import { resolveWithinRoot } from "../paths";
import { lspWorkspaceDir } from "./detect";
import { LspManager } from "./manager";
import {
  createLspSandbox,
  type LspSandbox,
  type LspSandboxMode,
  type LspSandboxStatus,
} from "./sandbox";
import type { LspLanguage } from "./specs";
import { buildLspTools } from "./tools";

/** How long to wait for a server's first non-empty diagnostics for a file. */
const DIAGNOSTICS_WAIT_MS = 20_000;

/**
 * The hostile-checkout check for the language-server sandbox, with the REAL
 * servers (TypeScript 7, pyright). Shared by `sandbox-check.test.ts` (host)
 * and the production image's `node apps/server/dist/lsp-sandbox-check.mjs`
 * (`apps/server/src/lsp-sandbox-check.ts`), so both run the same fixture.
 *
 * The fixture is a checkout next to another checkout holding a secret:
 *
 * - `tsconfig.json` `extends` a config in the other checkout, lists its file
 *   in `files` and `include`, and maps a `paths` alias into it;
 *   `src/main.ts` imports the secret module by a relative path out of the
 *   checkout, by alias, and through `src/linked.ts`, a symlink in the checkout
 *   that points into the other checkout.
 * - `pyrightconfig.json` lists the other checkout in `extraPaths` and
 *   `include`; `app/main.py` imports the secret module directly and through
 *   the symlink `app/linked_mod.py`.
 *
 * The secret module declares the secret marker as a string literal type, a
 * doc comment, a docstring and a symbol name, and each main file assigns that
 * literal type to a number, so a server that read the secret reports it in a
 * type error. Every LSP tool is called at every import and use. The marker
 * and the other checkout's path must appear in no output (definition,
 * references, hover, workspace and document symbols) and in none of the
 * diagnostics the servers publish (no tool forwards diagnostics to the model;
 * the check reads them with `LspClient.onDiagnostics` anyway).
 *
 * Then the same sandbox launches a probe process exactly as it launches a
 * server, which tries to read the other checkout, list the fixture's parent
 * directory, read through the symlink, read `/proc/1/environ` and
 * `/proc/<pid>/environ` of the process that started it (the app, holding
 * DATABASE_URL and the secrets), the app's own dist, `/etc/passwd`, and open
 * a TCP connection to a listener of the check (denied from Landlock ABI 4).
 * With `workDir` (the CLI's `--work-dir /data`), it also tries to list that
 * directory itself and, where they exist, its real `checkouts/`, `repos/`,
 * `tmp/` and `ssh/` subdirectories, and to read one real file of another
 * checkout and of a bare clone; what was absent is reported in `skipped`.
 * Every one of those must be denied; the checkout must stay readable and the
 * private HOME writable.
 *
 * Unsandboxed (`off`), the same fixture does leak (the test and `--control`
 * assert that, so the check cannot pass vacuously). Sandboxed, in-checkout
 * answers must still work (`working`), so a sandbox that breaks the servers
 * cannot pass either.
 */
export type LspSandboxCheckCall = {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  leaked: boolean;
};

/** One access the probe process attempted from inside the sandbox. */
export type LspSandboxCheckProbe = {
  name: string;
  kind: "read" | "list" | "write" | "tcp";
  /** The sandbox must deny it (false: it must work, e.g. reading the checkout). */
  mustDeny: boolean;
  /** The check process itself (unsandboxed) can do it: a control run must leak it. */
  reachable: boolean;
  /** It worked from inside the launch. */
  allowed: boolean;
  /** `ok`, or the error code. */
  detail: string;
};

export type LspSandboxCheckResult = {
  sandbox: LspSandboxStatus;
  /** Whether the manager offered the LSP tools at all. */
  toolsOffered: boolean;
  calls: LspSandboxCheckCall[];
  /**
   * Some output contained the secret marker, the other checkout's path or
   * (tool output) the absolute data-dir path, or a must-deny probe worked.
   */
  leaked: boolean;
  /** The probe process's accesses (empty when the sandbox is unavailable). */
  probes: LspSandboxCheckProbe[];
  /** Work-dir targets that were not probed because they do not exist there. */
  skipped: string[];
  /** In-checkout answers that must work wherever the servers run. */
  working: Array<{ name: string; ok: boolean; output: string }>;
};

const TS_SECRET = (marker: string) => `/** ${marker} documentation that must stay outside. */
export function leakedHelper(input: string): "${marker}" {
  return "${marker}";
}

/** ${marker} value. */
export const leakedValue = "${marker}" as const;

export class ${marker}Class {
  readonly field = "${marker}";
}
`;

const PY_SECRET = (marker: string) => `from typing import Literal

LEAKED = "${marker}"


def leaked_helper() -> Literal["${marker}"]:
    """${marker} documentation that must stay outside."""
    return "${marker}"


class ${marker}Class:
    """${marker} class."""
`;

const TS_MAIN = `import { leakedHelper, leakedValue } from "../../outside/secret";
import { leakedHelper as viaAlias } from "@leak/secret";
import { leakedValue as viaLink } from "./linked";
import { localHelper } from "./local";

export const fromHelper = leakedHelper("x");
export const fromValue = leakedValue;
export const fromAlias = viaAlias("y");
export const fromLink = viaLink;
export const fromLocal = localHelper();
export const wrong: number = leakedHelper("z");
`;

const PY_MAIN = `from secret_mod import LEAKED, leaked_helper
from linked_mod import leaked_helper as via_link
from local_mod import local_helper

value = leaked_helper()
other = LEAKED
linked = via_link()
mine = local_helper()
wrong: int = leaked_helper()
`;

function writeFixture(base: string, marker: string) {
  // `outside` stands for another user's checkout under the data dir.
  const outside = path.join(base, "outside");
  const checkout = path.join(base, "checkout");
  for (const dir of [outside, path.join(checkout, "src"), path.join(checkout, "app")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(outside, "secret.ts"), TS_SECRET(marker));
  fs.writeFileSync(path.join(outside, "secret_mod.py"), PY_SECRET(marker));
  fs.writeFileSync(
    path.join(outside, "tsconfig.base.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext", paths: { "@leak/*": ["./*"] } },
    }),
  );
  fs.writeFileSync(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({
      extends: "../outside/tsconfig.base.json",
      files: ["../outside/secret.ts"],
      include: ["src/**/*", "../outside/**/*"],
    }),
  );
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "hostile" }));
  fs.writeFileSync(path.join(checkout, "src", "main.ts"), TS_MAIN);
  fs.writeFileSync(
    path.join(checkout, "src", "local.ts"),
    "export function localHelper(): number {\n  return 1;\n}\n",
  );
  // Symlinks committed in the repository, pointing out of the checkout.
  fs.symlinkSync("../../outside/secret.ts", path.join(checkout, "src", "linked.ts"));
  fs.symlinkSync("../../outside/secret_mod.py", path.join(checkout, "app", "linked_mod.py"));
  fs.writeFileSync(
    path.join(checkout, "pyrightconfig.json"),
    JSON.stringify({ extraPaths: ["../outside"], include: ["app", "../outside"] }),
  );
  fs.writeFileSync(path.join(checkout, "app", "main.py"), PY_MAIN);
  fs.writeFileSync(
    path.join(checkout, "app", "local_mod.py"),
    "def local_helper() -> int:\n    return 1\n",
  );
  return { outside, checkout };
}

/** 1-based line/column of every occurrence of `needle` in `text`. */
function positionsOf(text: string, needle: string): Array<{ line: number; column: number }> {
  const found: Array<{ line: number; column: number }> = [];
  text.split("\n").forEach((line, index) => {
    for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + 1)) {
      found.push({ line: index + 1, column: at + 1 });
    }
  });
  return found;
}

type ProbeSpec = {
  name: string;
  kind: LspSandboxCheckProbe["kind"];
  /** A path; for `write`, relative to $HOME; for `tcp`, unused. */
  target: string;
  port?: number;
  mustDeny: boolean;
};

/**
 * Run inside the launch with `node -e`: tries each access and prints one JSON
 * array of `{ allowed, detail }`.
 */
const PROBE_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const specs = JSON.parse(process.argv[1]);
const tcp = (port) => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1");
  const timer = setTimeout(() => { socket.destroy(); resolve({ allowed: false, detail: "timeout" }); }, 5000);
  socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve({ allowed: true, detail: "ok" }); });
  socket.on("error", (error) => { clearTimeout(timer); resolve({ allowed: false, detail: error.code || String(error) }); });
});
(async () => {
  const out = [];
  for (const spec of specs) {
    try {
      if (spec.kind === "tcp") { out.push(await tcp(spec.port)); continue; }
      if (spec.kind === "read") fs.readFileSync(spec.target);
      else if (spec.kind === "list") fs.readdirSync(spec.target);
      else fs.writeFileSync(path.join(process.env.HOME, spec.target), "probe");
      out.push({ allowed: true, detail: "ok" });
    } catch (error) {
      out.push({ allowed: false, detail: error.code || String(error) });
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
`;

/** Whether the check process itself (unsandboxed) can do what `spec` asks. */
function reachableHere(spec: ProbeSpec): boolean {
  try {
    if (spec.kind === "read") fs.readFileSync(spec.target);
    else if (spec.kind === "list") fs.readdirSync(spec.target);
    return true;
  } catch {
    return false;
  }
}

/**
 * PIDs of running Cockpit Context app servers (`…/apps/server/dist/index.mjs`, e.g. the
 * container's app next to this check), whose environment holds the secrets.
 */
function runningAppServerPids(): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (cmdline.some((arg) => arg.endsWith("apps/server/dist/index.mjs"))) {
        pids.push(Number(entry));
      }
    } catch {
      // Gone, or not ours.
    }
  }
  return pids.slice(0, 4);
}

const isDir = (target: string) => {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The first regular file (not a symlink) at most `depth` levels under `dir`,
 * visiting at most 200 entries, skipping `exclude`.
 */
function firstFile(dir: string, depth: number, exclude: string): string | undefined {
  let budget = 200;
  const walk = (current: string, left: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      budget -= 1;
      if (budget < 0) return undefined;
      const full = path.join(current, entry.name);
      if (full === exclude || entry.name === ".git") continue;
      if (entry.isFile()) return full;
      if (entry.isDirectory() && left > 0) {
        const found = walk(full, left - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(dir, depth);
}

/**
 * The real data-dir layout under `workDir` (COCKPIT_CONTEXT_DATA_DIR: `repos/`,
 * `checkouts/`, `tmp/`, see packages/repos/src/paths.ts; `ssh/` too if a
 * deployment has one): its own listing, each subdirectory's listing, one file
 * of a real checkout and one of a real bare clone. All must be denied. What
 * does not exist is returned in `skipped`, never silently dropped.
 */
function workDirSpecs(workDir: string, fixture: string): { specs: ProbeSpec[]; skipped: string[] } {
  const root = fs.realpathSync(workDir);
  const specs: ProbeSpec[] = [
    { name: `the work dir's listing (${root})`, kind: "list", target: root, mustDeny: true },
  ];
  const skipped: string[] = [];
  for (const sub of ["checkouts", "repos", "tmp", "ssh"]) {
    const target = path.join(root, sub);
    if (isDir(target)) {
      specs.push({ name: `the work dir's ${sub}/ listing`, kind: "list", target, mustDeny: true });
    } else {
      skipped.push(`${sub}/ (not present in ${root})`);
    }
  }
  const checkoutFile = isDir(path.join(root, "checkouts"))
    ? firstFile(path.join(root, "checkouts"), 4, fixture)
    : undefined;
  if (checkoutFile) {
    specs.push({
      name: `a real checkout's file (${path.relative(root, checkoutFile)})`,
      kind: "read",
      target: checkoutFile,
      mustDeny: true,
    });
  } else {
    skipped.push("a real checkout's file (no checkout with files under checkouts/)");
  }
  const cloneFile = isDir(path.join(root, "repos"))
    ? firstFile(path.join(root, "repos"), 2, fixture)
    : undefined;
  if (cloneFile) {
    specs.push({
      name: `a real bare clone's file (${path.relative(root, cloneFile)})`,
      kind: "read",
      target: cloneFile,
      mustDeny: true,
    });
  } else {
    skipped.push("a real bare clone's file (no clone with files under repos/)");
  }
  return { specs, skipped };
}

/** Launches the probe process through `sandbox` the way a server is launched. */
async function runProbes(
  sandbox: LspSandbox,
  checkout: string,
  specs: ProbeSpec[],
): Promise<LspSandboxCheckProbe[]> {
  const launch = sandbox.launch({
    server: { command: process.execPath, args: ["-e", PROBE_SCRIPT, JSON.stringify(specs)] },
    checkoutRoot: checkout,
    workspaceRoot: checkout,
  });
  try {
    const { stdout, stderr, status } = await new Promise<{
      stdout: string;
      stderr: string;
      status: number | null;
    }>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: out, stderr: err, status: code }));
    });
    let results: Array<{ allowed: boolean; detail: string }>;
    try {
      results = JSON.parse(stdout) as Array<{ allowed: boolean; detail: string }>;
    } catch {
      throw new Error(`the probe process failed (exit ${status}): ${stderr.trim().slice(0, 500)}`);
    }
    return specs.map((spec, index) => ({
      name: spec.name,
      kind: spec.kind,
      mustDeny: spec.mustDeny,
      reachable: spec.kind === "tcp" || spec.kind === "write" || reachableHere(spec),
      allowed: results[index]?.allowed ?? false,
      detail: results[index]?.detail ?? "no result",
    }));
  } finally {
    launch.cleanup();
  }
}

/** A loopback TCP listener the probe tries to reach. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function runLspSandboxCheck(options: {
  sandbox: LspSandboxMode | LspSandbox;
  /** Parent of the fixture; a fresh temp directory when omitted (always removed). */
  workDir?: string;
  /** Files of the app the probe must not read (default: this module's own file, in the image the shipped dist). */
  appFiles?: string[];
}): Promise<LspSandboxCheckResult> {
  const marker = `cockpitContextSecret${randomBytes(6).toString("hex")}`;
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(options.workDir ?? os.tmpdir(), "cockpit-context-lsp-hostile-")),
  );
  const sandbox =
    typeof options.sandbox === "string"
      ? createLspSandbox({ mode: options.sandbox })
      : options.sandbox;
  const manager = new LspManager({
    sandbox,
    maxServers: 2,
    idleMs: 60_000,
    startTimeoutMs: 60_000,
    requestTimeoutMs: 60_000,
  });
  const listener = await listen();
  try {
    const { outside, checkout } = writeFixture(base, marker);
    // The probe is asynchronous: wait for its verdict (the app does not, and
    // offers no LSP tools until it passes).
    const status = (await manager.ready()).sandbox;
    const tools = buildLspTools({ manager, checkoutId: "hostile", root: checkout });
    const result: LspSandboxCheckResult = {
      sandbox: status,
      toolsOffered: tools.length > 0,
      calls: [],
      leaked: false,
      probes: [],
      skipped: [],
      working: [],
    };
    if (tools.length === 0) return result;
    const workDir = options.workDir ? workDirSpecs(options.workDir, base) : undefined;
    result.skipped = workDir?.skipped ?? [];

    const appFiles = options.appFiles ?? [fileURLToPath(import.meta.url)];
    const specs: ProbeSpec[] = [
      {
        name: "another checkout's file",
        kind: "read",
        target: path.join(outside, "secret.ts"),
        mustDeny: true,
      },
      { name: "another checkout's listing", kind: "list", target: outside, mustDeny: true },
      {
        name: "the fixture's parent directory listing (holds both checkouts)",
        kind: "list",
        target: base,
        mustDeny: true,
      },
      ...(workDir?.specs ?? []),
      {
        name: "a symlink in the checkout pointing outside",
        kind: "read",
        target: path.join(checkout, "src", "linked.ts"),
        mustDeny: true,
      },
      { name: "/proc/1/environ", kind: "read", target: "/proc/1/environ", mustDeny: true },
      {
        name: "the app's environment (/proc/<app pid>/environ)",
        kind: "read",
        target: `/proc/${process.pid}/environ`,
        mustDeny: true,
      },
      ...runningAppServerPids().map((pid) => ({
        name: `the running app server's environment (/proc/${pid}/environ)`,
        kind: "read" as const,
        target: `/proc/${pid}/environ`,
        mustDeny: true,
      })),
      ...appFiles.map((file) => ({
        name: `the app's code (${path.basename(file)})`,
        kind: "read" as const,
        target: file,
        mustDeny: true,
      })),
      { name: "/etc/passwd", kind: "read", target: "/etc/passwd", mustDeny: true },
      {
        name: "TCP connect to 127.0.0.1",
        kind: "tcp",
        target: "",
        port: listener.port,
        // Landlock denies TCP from ABI 4; a control run must connect.
        mustDeny: status.mode !== "landlock" || status.tcp,
      },
      {
        name: "a file in the checkout",
        kind: "read",
        target: path.join(checkout, "src", "local.ts"),
        mustDeny: false,
      },
      { name: "the private HOME", kind: "write", target: "probe.txt", mustDeny: false },
    ];
    result.probes = await runProbes(sandbox, checkout, specs);
    if (result.probes.some((probe) => probe.mustDeny && probe.allowed)) result.leaked = true;
    // What must keep working (a TCP probe below Landlock ABI 4 is neither).
    for (const probe of result.probes.filter((c) => !c.mustDeny && c.kind !== "tcp")) {
      result.working.push({
        name: `probe: ${probe.name}`,
        ok: probe.allowed,
        output: probe.detail,
      });
    }

    const record = (tool: string, input: Record<string, unknown>, output: string) => {
      // Tool output must also never show the absolute data-dir layout (the
      // fixture's base). Raw diagnostics carry the checkout's URI by design;
      // no tool forwards them.
      const leaked =
        output.includes(marker) ||
        output.includes(outside) ||
        (tool !== "diagnostics" && output.includes(base));
      result.calls.push({ tool, input, output, leaked });
      if (leaked) result.leaked = true;
    };
    const call = async (tool: string, input: Record<string, unknown>) => {
      const found = tools.find((candidate) => candidate.name === tool);
      let output: string;
      try {
        output = String(await found?.execute(input, new AbortController().signal));
      } catch (error) {
        output = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      record(tool, input, output);
      return output;
    };

    const files: Array<{ file: string; text: string; language: LspLanguage; names: string[] }> = [
      {
        file: "src/main.ts",
        text: TS_MAIN,
        language: "typescript",
        names: ["leakedHelper", "leakedValue", "viaAlias", "viaLink"],
      },
      {
        file: "app/main.py",
        text: PY_MAIN,
        language: "python",
        names: ["LEAKED", "leaked_helper", "via_link"],
      },
    ];

    // Diagnostics first: they are published when a document is opened.
    for (const { file, text, language } of files) {
      const published = await collectDiagnostics(manager, checkout, language, file, text);
      record("diagnostics", { path: file }, published.join("\n"));
    }

    for (const { file, text, names } of files) {
      for (const name of names) {
        for (const position of positionsOf(text, name)) {
          const input = { path: file, ...position };
          await call("lsp_hover", input);
          await call("lsp_definition", input);
          await call("lsp_references", input);
        }
      }
      await call("lsp_document_symbols", { path: file });
    }
    // Never the marker itself: the output echoes the query.
    for (const query of ["leaked", "cockpitContextSecret"]) {
      await call("lsp_workspace_symbols", { query });
    }

    const [tsLocal] = positionsOf(TS_MAIN, "localHelper()");
    const [pyLocal] = positionsOf(PY_MAIN, "local_helper()");
    const working = async (name: string, tool: string, input: object, expect: string) => {
      const output = await call(tool, input as Record<string, unknown>);
      result.working.push({ name, ok: output.includes(expect), output });
    };
    await working(
      "TypeScript definition inside the checkout",
      "lsp_definition",
      { path: "src/main.ts", ...tsLocal },
      "src/local.ts:1:17",
    );
    await working(
      "TypeScript hover inside the checkout",
      "lsp_hover",
      { path: "src/main.ts", ...tsLocal },
      "localHelper(): number",
    );
    await working(
      "Python definition inside the checkout",
      "lsp_definition",
      { path: "app/main.py", ...pyLocal },
      "app/local_mod.py:1:5",
    );
    await working(
      "Python hover inside the checkout",
      "lsp_hover",
      { path: "app/main.py", ...pyLocal },
      "def local_helper() -> int",
    );
    return result;
  } finally {
    await manager.dispose();
    await listener.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Opens `file` on its language's server (the same server the tools use) and
 * returns its diagnostics: the `textDocument/diagnostic` pull (both servers
 * answer it; TypeScript 7 answers with no items for this client, which
 * declares no diagnostic capability), every `publishDiagnostics` push that
 * arrives meanwhile, and, when the pull fails, the pushes until the file's
 * first non-empty one or `DIAGNOSTICS_WAIT_MS`.
 */
async function collectDiagnostics(
  manager: LspManager,
  checkout: string,
  language: LspLanguage,
  file: string,
  text: string,
): Promise<string[]> {
  const spec = manager.specs[language];
  const workspaceDir = lspWorkspaceDir(checkout, undefined, spec);
  const published: string[] = [];
  try {
    await manager.use(
      { checkoutId: "hostile", language, workspaceDir },
      { checkoutRoot: checkout, workspaceRoot: resolveWithinRoot(checkout, workspaceDir) },
      async (client) => {
        let uri = "";
        let pushed = () => {};
        const pushedOnce = new Promise<void>((resolve) => {
          pushed = resolve;
        });
        const off = client.onDiagnostics((params) => {
          published.push(`push: ${JSON.stringify(params)}`);
          if (params.uri === uri && params.diagnostics.length > 0) pushed();
        });
        try {
          const languageId = spec.languageIds[path.extname(file)] ?? language;
          uri = client.openDocument(path.join(checkout, file), languageId, text);
          let pulled = false;
          try {
            const report = await client.request(
              DocumentDiagnosticRequest.type,
              { textDocument: { uri } },
              { timeoutMs: DIAGNOSTICS_WAIT_MS },
            );
            published.push(`pull: ${JSON.stringify(report)}`);
            pulled = true;
          } catch (error) {
            published.push(`pull: ERROR ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!pulled) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
              pushedOnce,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, DIAGNOSTICS_WAIT_MS);
              }),
            ]);
            clearTimeout(timer);
          }
        } finally {
          off();
        }
      },
    );
  } catch (error) {
    published.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
  return published;
}
