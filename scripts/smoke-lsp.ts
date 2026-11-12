/**
 * Manual smoke: run the real language servers behind the LSP tools against the
 * explore fixtures, and check each tool's answer.
 *
 *   pnpm run lsp:smoke
 *
 * - TypeScript: TypeScript 7's native server (`tsc --lsp --stdio`) on
 *   packages/explore/fixtures/sample-pkg.
 * - Python: `pyright-langserver --stdio` on packages/explore/fixtures/sample-py.
 *
 * Free and offline (no model, no network), but it spawns real servers, so it
 * is not part of `verify` or the unit tests (those use a fake LSP process). Run
 * it after bumping `typescript` or `pyright`, and in the production image.
 * Exits non-zero when any check fails.
 */

import path from "node:path";

import type { AgentTool } from "../packages/agent-runtime/src/index.ts";
import { buildLspTools, LspManager } from "../packages/explore/src/index.ts";

const fixtures = path.resolve(import.meta.dirname, "../packages/explore/fixtures");

type Check = {
  tool: string;
  input: Record<string, unknown>;
  /** Substrings the fenced result must contain. */
  expect: string[];
};

const CASES: Array<{ name: string; checkoutId: string; root: string; checks: Check[] }> = [
  {
    name: "TypeScript (sample-pkg)",
    checkoutId: "smoke-ts",
    root: path.join(fixtures, "sample-pkg"),
    checks: [
      {
        tool: "lsp_definition",
        input: { path: "examples/basic.ts", line: 3, column: 13 },
        expect: ["src/greet.ts:2:17", "export function greet"],
      },
      {
        tool: "lsp_references",
        input: { path: "src/greet.ts", line: 2, column: 17 },
        expect: ["examples/basic.ts:3:13", "src/greet.ts:2:17"],
      },
      {
        tool: "lsp_hover",
        input: { path: "examples/basic.ts", line: 3, column: 13 },
        expect: ["greet(name: string, shout?: boolean): string"],
      },
      {
        tool: "lsp_workspace_symbols",
        input: { query: "GreetOptions" },
        expect: ["GreetOptions", "src/greet.ts:7:"],
      },
      {
        tool: "lsp_document_symbols",
        input: { path: "src/greet.ts" },
        expect: ["function greet", "GreetOptions"],
      },
    ],
  },
  {
    name: "Python (sample-py)",
    checkoutId: "smoke-py",
    root: path.join(fixtures, "sample-py"),
    checks: [
      {
        tool: "lsp_definition",
        input: { path: "examples/basic.py", line: 3, column: 7 },
        expect: ["sample_py/greet.py:4:5", "def greet"],
      },
      {
        tool: "lsp_references",
        input: { path: "sample_py/greet.py", line: 4, column: 5 },
        expect: ["examples/basic.py:3:7", "sample_py/greet.py:17:16"],
      },
      {
        tool: "lsp_hover",
        input: { path: "sample_py/greet.py", line: 4, column: 5 },
        expect: ["def greet(", "shout: bool = False", "-> str"],
      },
      {
        tool: "lsp_workspace_symbols",
        input: { query: "Greeter" },
        expect: ["class Greeter", "sample_py/greet.py:10:7"],
      },
      {
        tool: "lsp_document_symbols",
        input: { path: "sample_py/greet.py" },
        expect: ["function greet", "class Greeter", "method greet"],
      },
    ],
  },
];

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

// The servers run as the app runs them: in the Landlock sandbox
// (COCKPIT_CONTEXT_LSP_SANDBOX=required; `pnpm run lsp:build-sandbox` builds the helper).
// Where it cannot sandbox, nothing starts.
const manager = new LspManager({ maxServers: 2, idleMs: 60_000, sandbox: "required" });
const status = await manager.ready();
console.log(`sandbox: ${JSON.stringify(status.sandbox)}`);
if (!status.enabled) {
  console.error("The language-server sandbox is unavailable here; the LSP tools are disabled.");
  process.exit(2);
}
let failures = 0;

try {
  for (const testCase of CASES) {
    console.log(`\n=== ${testCase.name}`);
    const tools = buildLspTools({ manager, checkoutId: testCase.checkoutId, root: testCase.root });
    console.log(`tools: ${tools.map((tool) => tool.name).join(", ") || "(none)"}`);
    for (const check of testCase.checks) {
      const started = Date.now();
      let output: string;
      try {
        const tool = toolByName(tools, check.tool);
        output = String(await tool.execute(check.input, new AbortController().signal));
      } catch (error) {
        output = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      const missing = check.expect.filter((needle) => !output.includes(needle));
      const status = missing.length === 0 ? "ok  " : "FAIL";
      if (missing.length > 0) failures += 1;
      console.log(
        `${status} ${check.tool} ${JSON.stringify(check.input)} (${Date.now() - started} ms)`,
      );
      const body = output
        .split("\n")
        .filter((line) => !line.startsWith("<<<") && !line.startsWith(">>>"))
        .join("\n");
      console.log(body.replace(/^/gm, "     | "));
      if (missing.length > 0) console.log(`     missing: ${JSON.stringify(missing)}`);
    }
    console.log(
      `running: ${manager
        .running()
        .map((server) => `${server.checkoutId}/${server.language} pid=${server.pid}`)
        .join(", ")}`,
    );
  }

  // LRU cap of 2 holds; stopping a checkout stops its server.
  await manager.stopCheckout("smoke-ts");
  const left = manager.running().map((server) => server.checkoutId);
  if (left.includes("smoke-ts")) {
    failures += 1;
    console.log("FAIL stopCheckout left the smoke-ts server running");
  } else {
    console.log(`\nok   stopCheckout(smoke-ts); still running: ${left.join(", ") || "(none)"}`);
  }
} finally {
  await manager.dispose();
}

console.log(failures === 0 ? "\nLSP smoke passed." : `\nLSP smoke: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
