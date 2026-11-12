import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LspManager } from "./manager";
import {
  callLspTool,
  cleanupFakeLsp,
  readLog,
  setupFakeLsp,
  tempDir,
  testSandbox,
} from "./test-support/fake-lsp";
import { buildLspTools, LSP_TOOL_NAMES, redactCheckoutPaths } from "./tools";

const START = "<<<UNTRUSTED_WEB_CONTENT_START>>>";
const END = "<<<UNTRUSTED_WEB_CONTENT_END>>>";

afterEach(async () => {
  await cleanupFakeLsp();
});

const definition = { path: "src/greet.ts", line: 1, column: 17 };

describe("redactCheckoutPaths", () => {
  it("replaces the checkout's absolute path and file URI with `.`, and nothing else", () => {
    const roots = ["/data/checkouts/abc def", "/data/link/abc"];
    expect(
      redactCheckoutPaths(
        [
          'module "/data/checkouts/abc def/src/a"',
          "file:///data/checkouts/abc%20def/src/a.ts:1:2",
          "cwd /data/checkouts/abc def",
          "via /data/link/abc/x.py",
          "sibling /data/checkouts/abc def-2/x.ts",
          "/usr/lib/node_modules/typescript/lib.d.ts",
        ].join("\n"),
        roots,
      ).split("\n"),
    ).toEqual([
      'module "./src/a"',
      "./src/a.ts:1:2",
      "cwd .",
      "via ./x.py",
      "sibling /data/checkouts/abc def-2/x.ts",
      "/usr/lib/node_modules/typescript/lib.d.ts",
    ]);
  });
});

describe("buildLspTools registration", () => {
  it("registers the five untrusted tools when the checkout has a supported language", () => {
    const { root, manager } = setupFakeLsp();
    const tools = buildLspTools({ manager, checkoutId: "c", root });
    expect(tools.map((tool) => tool.name)).toEqual([...LSP_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.untrusted).toBe(true);
      expect(tool.description).toContain("TypeScript/JavaScript, Python");
    }
  });

  it("registers nothing for a checkout without TypeScript/JavaScript or Python files", () => {
    const root = tempDir("cockpit-context-lsp-none-");
    fs.writeFileSync(path.join(root, "README.md"), "# docs only\n");
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    expect(
      buildLspTools({ manager: new LspManager({ sandbox: testSandbox() }), checkoutId: "c", root }),
    ).toEqual([]);
  });

  it("detects a checkout's languages once per manager, until stopCheckout", async () => {
    const root = tempDir("cockpit-context-lsp-cache-");
    fs.writeFileSync(path.join(root, "README.md"), "# docs only\n");
    const manager = new LspManager({ sandbox: testSandbox() });
    expect(buildLspTools({ manager, checkoutId: "c", root })).toEqual([]);
    // A walk would now find a file; the cached detection does not walk again.
    fs.writeFileSync(path.join(root, "main.ts"), "export const x = 1;\n");
    expect(buildLspTools({ manager, checkoutId: "c", root })).toEqual([]);
    // Another checkout id at the same root is its own entry.
    expect(buildLspTools({ manager, checkoutId: "d", root })).toHaveLength(LSP_TOOL_NAMES.length);
    await manager.stopCheckout("c");
    expect(buildLspTools({ manager, checkoutId: "c", root })).toHaveLength(LSP_TOOL_NAMES.length);
    await manager.dispose();
  });

  it("caches the subdirectory detection separately and keeps an explicit languages map first", () => {
    const root = tempDir("cockpit-context-lsp-cache-sub-");
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg", "a.ts"), "export const a = 1;\n");
    const manager = new LspManager({ sandbox: testSandbox() });
    const first = manager.detectLanguages("c", root, "pkg");
    expect([...first.keys()]).toEqual(["typescript"]);
    expect(manager.detectLanguages("c", root, "pkg")).toBe(first);
    expect(manager.detectLanguages("c", root)).not.toBe(first);
    // An escaping subdirectory throws (not cached); the root samples stand.
    expect(() => manager.detectLanguages("c", root, "..")).toThrow();
    expect(buildLspTools({ manager, checkoutId: "c", root, subdirectory: ".." })).toHaveLength(
      LSP_TOOL_NAMES.length,
    );
    expect(buildLspTools({ manager, checkoutId: "c", root, languages: new Map() })).toEqual([]);
    void manager.dispose();
  });

  it("registers nothing when the manager is disabled (COCKPIT_CONTEXT_LSP_MAX_SERVERS=0)", () => {
    const { root } = setupFakeLsp();
    expect(
      buildLspTools({
        manager: new LspManager({ maxServers: 0, sandbox: testSandbox() }),
        checkoutId: "c",
        root,
      }),
    ).toEqual([]);
  });

  it("registers nothing when COCKPIT_CONTEXT_LSP_SANDBOX=required and the Landlock helper is missing", () => {
    const { root } = setupFakeLsp();
    const manager = new LspManager({
      sandbox: testSandbox({
        mode: "unavailable",
        reason: "missing",
        detail: "the Landlock helper is not installed",
      }),
    });
    expect(manager.enabled).toBe(false);
    expect(buildLspTools({ manager, checkoutId: "c", root })).toEqual([]);
    expect(manager.status()).toEqual({
      enabled: false,
      maxServers: 4,
      sandbox: {
        mode: "unavailable",
        reason: "missing",
        detail: "the Landlock helper is not installed",
        checkedAt: expect.any(String),
      },
    });
  });

  it("registers nothing while the sandbox probe is still running (fail closed)", () => {
    const { root } = setupFakeLsp();
    const manager = new LspManager({ sandbox: testSandbox({ mode: "probing" }) });
    expect(manager.enabled).toBe(false);
    expect(buildLspTools({ manager, checkoutId: "c", root })).toEqual([]);
    expect(manager.status().sandbox).toEqual({ mode: "probing", since: expect.any(String) });
  });

  it("names only the detected languages", () => {
    const { root, manager } = setupFakeLsp();
    fs.rmSync(path.join(root, "src", "tool.py"));
    const [tool] = buildLspTools({ manager, checkoutId: "c", root });
    expect(tool?.description).toContain("(TypeScript/JavaScript)");
    expect(tool?.description).not.toContain("Python");
  });
});

describe("LSP tool results", () => {
  it("fences the body as untrusted and renders checkout-relative locations", async () => {
    const { root, manager } = setupFakeLsp();
    const output = await callLspTool(manager, root, "lsp_definition", definition);
    expect(output.startsWith(START)).toBe(true);
    expect(output.trimEnd().endsWith(END)).toBe(true);
    expect(output).toContain("Source URL: checkout:lsp_definition:src/greet.ts");
    expect(output).toContain("1 location(s)");
    expect(output).toContain("src/greet.ts:1:17  export function greet(name: string): string {");
    // The fake also returns a location outside the checkout: omitted, counted.
    expect(output).toContain("1 result(s) outside the checkout omitted");
    expect(output).not.toContain("cockpit-context-fake-outside");
    expect(output).not.toContain(root);
  });

  it("converts 1-based line/column to the server's 0-based position", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_hover", { path: "src/greet.ts", line: 3, column: 5 });
    const hover = readLog(logFile).find((entry) => entry.method === "textDocument/hover");
    expect(hover?.params?.position).toEqual({ line: 2, character: 4 });
  });

  it("references honor the limit", async () => {
    const { root, manager } = setupFakeLsp();
    const output = await callLspTool(manager, root, "lsp_references", { ...definition, limit: 2 });
    expect(output).toContain("2 location(s) (1 more not shown");
    expect(output).toContain("src/greet.ts:1:1  export function greet");
    expect(output).toContain('src/greet.ts:2:1  const message = "hi " + name;');
    expect(output).not.toContain("src/greet.ts:3:1");
  });

  it("fills the limit with shown locations; outside and .git ones are counted, not shown", async () => {
    const { root, manager } = setupFakeLsp({ mode: "mixed-references" });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /data/repos/abc.git/worktrees/deadbeef\n");
    const capped = await callLspTool(manager, root, "lsp_references", { ...definition, limit: 2 });
    expect(capped).toContain(
      [
        "2 location(s) (1 more not shown; raise limit or narrow down)",
        "src/greet.ts:1:1  export function greet(name: string): string {",
        'src/greet.ts:2:1  const message = "hi " + name;',
        "(2 result(s) outside the checkout omitted",
      ].join("\n"),
    );
    const all = await callLspTool(manager, root, "lsp_references", { ...definition, limit: 10 });
    expect(all).toContain("3 location(s)\n");
    expect(all).toContain("src/greet.ts:3:1  return message;");
    expect(all).toContain("(2 result(s) outside the checkout omitted");
    expect(all).not.toContain("gitdir");
    expect(all).not.toContain(".git");
  });

  it("hover returns the server's text", async () => {
    const { root, manager } = setupFakeLsp();
    const output = await callLspTool(manager, root, "lsp_hover", definition);
    expect(output).toContain("function greet(name: string): string");
  });

  it("document symbols render an indented outline", async () => {
    const { root, manager } = setupFakeLsp();
    const output = await callLspTool(manager, root, "lsp_document_symbols", {
      path: "src/greet.ts",
    });
    expect(output).toContain("2 symbol(s) (line:col)");
    expect(output).toContain("function greet — (name: string) => string (1:17)");
    expect(output).toContain("  variable message (2:9)");
  });

  it("workspace symbols query every detected language and drop outside results", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    const output = await callLspTool(manager, root, "lsp_workspace_symbols", { query: "greet" });
    // One in-checkout hit per server (TypeScript and Python fakes both answer).
    expect(output).toContain("2 symbol(s)");
    expect(output).toContain("class greet — src/greet.ts:1:17");
    expect(output).not.toContain("greetOutside");
    expect(output).toContain("outside the checkout omitted");
    // A sample file was opened first so the server loads a project.
    const opened = readLog(logFile).filter((entry) => entry.method === "textDocument/didOpen");
    expect(opened.length).toBeGreaterThanOrEqual(2);
  });
});

describe("LSP tool errors", () => {
  it("rejects a path outside the checkout without naming the host path", async () => {
    const { root, manager } = setupFakeLsp();
    const failure = await callLspTool(manager, root, "lsp_definition", {
      path: "../outside.ts",
      line: 1,
      column: 1,
    }).catch((error: Error) => error.message);
    expect(failure).toContain("Path escapes explore root: ../outside.ts");
    expect(failure).toContain("Fall back to grep and read.");
    expect(failure).not.toContain(root);
  });

  it("refuses a file type no server handles here", async () => {
    const { root, manager } = setupFakeLsp();
    fs.writeFileSync(path.join(root, "src", "lib.rs"), "fn main() {}\n");
    await expect(
      callLspTool(manager, root, "lsp_definition", { path: "src/lib.rs", line: 1, column: 1 }),
    ).rejects.toThrow(/No language server for \.rs files here.*grep and read/);
  });

  it("reports a file in git metadata as not found", async () => {
    const { root, manager } = setupFakeLsp();
    fs.mkdirSync(path.join(root, "sub", ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", ".git", "hook.ts"), "export const x = 1;\n");
    await expect(
      callLspTool(manager, root, "lsp_document_symbols", { path: "sub/.git/hook.ts" }),
    ).rejects.toThrow(/^lsp_document_symbols failed: Not found: sub\/\.git\/hook\.ts\. Fall back/);
  });

  it("reports a missing file against the requested path", async () => {
    const { root, manager } = setupFakeLsp();
    await expect(
      callLspTool(manager, root, "lsp_document_symbols", { path: "src/missing.ts" }),
    ).rejects.toThrow(/Not found: src\/missing\.ts\. Fall back to grep and read\./);
  });
});
