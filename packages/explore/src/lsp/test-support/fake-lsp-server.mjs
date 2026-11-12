// A fake language server for the LSP manager/tool unit tests: speaks LSP's
// Content-Length framed JSON-RPC over stdio by hand (independent of the
// client library under test), logs every message it receives to
// FAKE_LSP_LOG as JSON lines, and misbehaves on demand via FAKE_LSP_MODE:
//
//   crash-on-request  exit(3) on the first textDocument/* request
//   hang              never answer textDocument/* requests
//   fail-init         exit(4) on initialize
//   ignore-shutdown   never answer shutdown, ignore exit (forces SIGKILL)
//   error             answer textDocument/* with a JSON-RPC error that names
//                     an absolute path (FAKE_LSP_ERROR_PATH)
//   introspect        answer hover with what the process sees (cwd, env keys,
//                     the initialize rootUri, the hovered URI, and which of
//                     FAKE_LSP_PROBE_PATHS (":"-separated) it can read): the
//                     sandbox tests run it inside the Landlock sandbox, where it cannot log
//   mixed-references  answer references with an outside location, a duplicate and
//                     the checkout's root `.git` among the hits
//
// Answers are canned: one location in the requested document plus one
// outside the checkout, a markdown hover, a two-level outline, and one
// workspace symbol at FAKE_LSP_SYMBOL_URI.

import fs from "node:fs";

const mode = process.env.FAKE_LSP_MODE ?? "";
const logFile = process.env.FAKE_LSP_LOG;

function log(entry) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

log({ event: "start", argv: process.argv.slice(2), cwd: process.cwd(), env: process.env });

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

let nextId = 1000;
const OUTSIDE_URI = "file:///cockpit-context-fake-outside/lib.d.ts";
let initializeParams;

function canRead(file) {
  try {
    fs.readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function introspection(uri) {
  const probes = (process.env.FAKE_LSP_PROBE_PATHS ?? "").split(":").filter(Boolean);
  return JSON.stringify({
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    path: process.env.PATH,
    home: process.env.HOME,
    rootUri: initializeParams?.rootUri,
    workspaceFolders: initializeParams?.workspaceFolders,
    uri,
    readable: Object.fromEntries(probes.map((file) => [file, canRead(file)])),
  });
}

function answer(message) {
  const { method, params } = message;
  if (method.startsWith("textDocument/")) {
    if (mode === "crash-on-request") process.exit(3);
    if (mode === "hang") return undefined;
    if (mode === "error") {
      return {
        error: {
          code: -32603,
          message: `internal failure reading ${process.env.FAKE_LSP_ERROR_PATH ?? "/somewhere"}/x.ts`,
        },
      };
    }
  }
  const uri = params?.textDocument?.uri;
  switch (method) {
    case "initialize":
      if (mode === "fail-init") process.exit(4);
      initializeParams = params;
      return {
        result: {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
          },
          serverInfo: { name: "fake-lsp" },
        },
      };
    case "shutdown":
      if (mode === "ignore-shutdown") return undefined;
      return { result: null };
    case "textDocument/definition":
      return {
        result: [
          { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } },
          {
            uri: OUTSIDE_URI,
            range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
          },
        ],
      };
    case "textDocument/references":
      if (mode === "mixed-references") {
        // In order: outside, a hit, its duplicate, the checkout's root `.git`, two more hits.
        const at = (target, line) => ({
          uri: target,
          range: { start: { line, character: 0 }, end: { line, character: 1 } },
        });
        const gitUri = new URL("../.git", uri).href;
        return {
          result: [
            at(OUTSIDE_URI, 0),
            at(uri, 0),
            at(uri, 0),
            at(gitUri, 0),
            at(uri, 1),
            at(uri, 2),
          ],
        };
      }
      return {
        result: [0, 1, 2].map((line) => ({
          uri,
          range: { start: { line, character: 0 }, end: { line, character: 1 } },
        })),
      };
    case "textDocument/hover":
      if (mode === "introspect") {
        return { result: { contents: { kind: "plaintext", value: introspection(uri) } } };
      }
      return {
        result: {
          contents: { kind: "markdown", value: "```ts\nfunction greet(name: string): string\n```" },
        },
      };
    case "textDocument/documentSymbol":
      return {
        result: [
          {
            name: "greet",
            kind: 12,
            detail: "(name: string) => string",
            range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
            selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
            children: [
              {
                name: "message",
                kind: 13,
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 30 } },
                selectionRange: {
                  start: { line: 1, character: 8 },
                  end: { line: 1, character: 15 },
                },
              },
            ],
          },
        ],
      };
    case "workspace/symbol":
      return {
        result: [
          {
            name: params.query,
            kind: 5,
            location: {
              uri: process.env.FAKE_LSP_SYMBOL_URI ?? OUTSIDE_URI,
              range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
            },
          },
          {
            name: `${params.query}Outside`,
            kind: 5,
            location: {
              uri: OUTSIDE_URI,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          },
        ],
      };
    default:
      return { result: null };
  }
}

function handle(message) {
  log({
    event: "message",
    method: message.method,
    id: message.id,
    params: message.params,
    result: message.result,
  });
  if (message.method === undefined) return; // a response to our own request
  if (message.method === "exit") {
    if (mode !== "ignore-shutdown") process.exit(0);
    return;
  }
  if (message.method === "initialized") {
    send({
      id: nextId++,
      method: "workspace/configuration",
      params: { items: [{ section: "js/ts" }, { section: "python.analysis" }] },
    });
    return;
  }
  if (message.id === undefined) return; // other notifications
  const reply = answer(message);
  if (reply) send({ id: message.id, ...reply });
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on("end", () => {
  if (mode !== "ignore-shutdown") process.exit(0);
});
