import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LspError } from "./client";
import { LANGUAGE_SERVER_SPECS } from "./specs";
import { callLspTool, cleanupFakeLsp, readLog, setupFakeLsp } from "./test-support/fake-lsp";
import { buildLspTools } from "./tools";

afterEach(async () => {
  await cleanupFakeLsp();
  delete process.env.COCKPIT_CONTEXT_TEST_SECRET;
});

const definition = { path: "src/greet.ts", line: 1, column: 17 };

describe("LspManager lifecycle (fake LSP process)", () => {
  it("starts lazily on the first call and initializes at the workspace root", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    buildLspTools({ manager, checkoutId: "checkout-1", root });
    expect(readLog(logFile)).toEqual([]);
    expect(manager.running()).toEqual([]);

    const output = await callLspTool(manager, root, "lsp_definition", definition);
    expect(output).toContain("src/greet.ts:1:17  export function greet(name: string): string {");

    const log = readLog(logFile);
    const start = log.find((entry) => entry.event === "start");
    expect(start?.cwd).toBe(root);
    const initialize = log.find((entry) => entry.method === "initialize");
    expect(initialize?.params).toMatchObject({
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: { workspace: { configuration: true } },
    });
    expect(log.some((entry) => entry.method === "initialized")).toBe(true);
    expect(log.some((entry) => entry.method === "textDocument/didOpen")).toBe(true);
    expect(manager.running()).toEqual([
      expect.objectContaining({ checkoutId: "checkout-1", language: "typescript", inFlight: 0 }),
    ]);
  });

  it("answers workspace/configuration from the spec (TypeScript: type acquisition off)", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_hover", definition);
    await vi.waitFor(() => {
      const reply = readLog(logFile).find(
        (entry) => entry.method === undefined && Array.isArray(entry.result),
      );
      expect(reply?.result).toEqual([
        LANGUAGE_SERVER_SPECS.typescript.configuration("js/ts"),
        LANGUAGE_SERVER_SPECS.typescript.configuration("python.analysis"),
      ]);
    });
    expect(LANGUAGE_SERVER_SPECS.typescript.configuration("js/ts")).toMatchObject({
      tsserver: { automaticTypeAcquisition: { enabled: false } },
    });
  });

  it("spawns with a minimal env: no host variables, PATH at an empty directory", async () => {
    process.env.COCKPIT_CONTEXT_TEST_SECRET = "do-not-leak";
    const { root, logFile, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_definition", definition);

    const env = readLog(logFile).find((entry) => entry.event === "start")?.env ?? {};
    expect(env.COCKPIT_CONTEXT_TEST_SECRET).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(
      [
        "FAKE_LSP_ERROR_PATH",
        "FAKE_LSP_LOG",
        "FAKE_LSP_MODE",
        "FAKE_LSP_SYMBOL_URI",
        "HOME",
        "LANG",
        "OPENSSL_CONF",
        "PATH",
        "TMPDIR",
      ].sort(),
    );
    expect(env.PATH).not.toContain(path.delimiter);
    expect(fs.readdirSync(env.PATH as string)).toEqual([]);
    expect(env.HOME?.startsWith(os.tmpdir())).toBe(true);
  });

  it("gives each server its own private directory and removes it when the server stops", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_definition", definition);
    await callLspTool(manager, root, "lsp_document_symbols", { path: "src/tool.py" });
    const homes = readLog(logFile)
      .filter((entry) => entry.event === "start")
      .map((entry) => path.dirname(entry.env?.HOME ?? ""));
    expect(new Set(homes).size).toBe(2);
    for (const home of homes) expect(fs.existsSync(home)).toBe(true);
    await manager.stopCheckout("checkout-1");
    for (const home of homes) expect(fs.existsSync(home)).toBe(false);
  });

  it("reuses one server per (checkout, language) and starts one per language", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_definition", definition);
    await callLspTool(manager, root, "lsp_references", definition);
    await callLspTool(manager, root, "lsp_document_symbols", { path: "src/tool.py" });
    const starts = readLog(logFile).filter((entry) => entry.event === "start");
    expect(starts).toHaveLength(2);
    expect(
      manager
        .running()
        .map((server) => server.language)
        .sort(),
    ).toEqual(["python", "typescript"]);
  });

  it("stops a server after the idle timeout with shutdown + exit", async () => {
    const { root, logFile, manager } = setupFakeLsp({ manager: { idleMs: 50 } });
    await callLspTool(manager, root, "lsp_definition", definition);
    await vi.waitFor(() => expect(manager.running()).toEqual([]), { timeout: 3_000 });
    await vi.waitFor(() => {
      const methods = readLog(logFile).map((entry) => entry.method);
      expect(methods).toContain("shutdown");
      expect(methods).toContain("exit");
    });
  });

  it("evicts the least recently used server past maxServers", async () => {
    const { root, logFile, manager } = setupFakeLsp({ manager: { maxServers: 1 } });
    await callLspTool(manager, root, "lsp_definition", definition, "checkout-a");
    await callLspTool(manager, root, "lsp_definition", definition, "checkout-b");
    expect(manager.running().map((server) => server.checkoutId)).toEqual(["checkout-b"]);
    await vi.waitFor(() =>
      expect(readLog(logFile).filter((entry) => entry.method === "shutdown")).toHaveLength(1),
    );
  });

  it("stopCheckout stops only that checkout's servers", async () => {
    const { root, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_definition", definition, "checkout-a");
    await callLspTool(manager, root, "lsp_definition", definition, "checkout-b");
    await manager.stopCheckout("checkout-a");
    expect(manager.running().map((server) => server.checkoutId)).toEqual(["checkout-b"]);
  });

  it("dispose stops everything and refuses further use", async () => {
    const { root, manager } = setupFakeLsp();
    await callLspTool(manager, root, "lsp_definition", definition);
    await manager.dispose();
    expect(manager.running()).toEqual([]);
    expect(manager.enabled).toBe(false);
    await expect(
      manager.use(
        { checkoutId: "x", language: "typescript", workspaceDir: "." },
        { checkoutRoot: root, workspaceRoot: root },
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(LspError);
  });

  it("reads a document's text only when it is not open yet", async () => {
    const { root, logFile, manager } = setupFakeLsp();
    await manager.ready();
    const real = fs.realpathSync(root);
    const file = path.join(real, "src", "greet.ts");
    const text = vi.fn(() => fs.readFileSync(file, "utf8"));
    const uris = await manager.use(
      { checkoutId: "checkout-1", language: "typescript", workspaceDir: "." },
      { checkoutRoot: real, workspaceRoot: real },
      async (client) => [
        client.openDocument(file, "typescript", text),
        client.openDocument(file, "typescript", text),
        client.openDocument(file, "typescript", "ignored for an open document"),
      ],
    );
    expect(new Set(uris)).toEqual(new Set([pathToFileURL(file).href]));
    expect(text).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(readLog(logFile).filter((e) => e.method === "textDocument/didOpen")).toHaveLength(1);
    });
  });

  it("SIGKILLs a server that ignores shutdown", async () => {
    const { root, manager } = setupFakeLsp({ mode: "ignore-shutdown" });
    await callLspTool(manager, root, "lsp_definition", definition);
    const pid = manager.running()[0]?.pid;
    expect(pid).toBeDefined();
    await manager.stopCheckout("checkout-1");
    expect(() => process.kill(pid as number, 0)).toThrow();
  });
});

describe("LSP failures become grep/read fallback tool errors", () => {
  it("a crash mid-request is a tool error; the next call restarts the server", async () => {
    const { root, logFile, manager } = setupFakeLsp({ mode: "crash-on-request" });
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow(
      /lsp_definition failed: the language server stopped\. Fall back to grep and read\./,
    );
    await expect(callLspTool(manager, root, "lsp_hover", definition)).rejects.toThrow(
      /grep and read/,
    );
    expect(readLog(logFile).filter((entry) => entry.event === "start")).toHaveLength(2);
  });

  it("refuses a server that keeps failing (maxFailures)", async () => {
    const { root, logFile, manager } = setupFakeLsp({
      mode: "crash-on-request",
      manager: { maxFailures: 2 },
    });
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow();
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow();
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow(
      /failed repeatedly.*grep and read/,
    );
    expect(readLog(logFile).filter((entry) => entry.event === "start")).toHaveLength(2);
    // Pruning the checkout forgets the failures.
    await manager.stopCheckout("checkout-1");
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow(
      /language server stopped/,
    );
  });

  it("a server that dies during initialize is a start failure", async () => {
    const { root, manager } = setupFakeLsp({ mode: "fail-init" });
    await expect(callLspTool(manager, root, "lsp_definition", definition)).rejects.toThrow(
      /lsp_definition failed: the language server is unavailable.*grep and read/,
    );
    expect(manager.running()).toEqual([]);
  });

  it("a request that hangs times out and is cancelled", async () => {
    const { root, logFile, manager } = setupFakeLsp({
      mode: "hang",
      manager: { requestTimeoutMs: 200 },
    });
    await expect(callLspTool(manager, root, "lsp_hover", definition)).rejects.toThrow(
      /did not answer in time\. Fall back to grep and read\./,
    );
    await vi.waitFor(() =>
      expect(readLog(logFile).some((entry) => entry.method === "$/cancelRequest")).toBe(true),
    );
    // The server itself is still usable for the next call.
    expect(manager.running()).toHaveLength(1);
  });

  it("an aborted call stops waiting", async () => {
    const { root, manager } = setupFakeLsp({ mode: "hang" });
    const tool = buildLspTools({ manager, checkoutId: "checkout-1", root }).find(
      (candidate) => candidate.name === "lsp_definition",
    );
    const controller = new AbortController();
    const pending = Promise.resolve(tool?.execute(definition, controller.signal));
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("scrubs the checkout's host path out of a server error", async () => {
    const { root, manager } = setupFakeLsp({ mode: "error" });
    const failure = await callLspTool(manager, root, "lsp_definition", definition).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain("the language server returned an error");
    expect(failure).toContain("./x.ts");
    expect(failure).not.toContain(root);
  });
});
