import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type AgentTool, defineTool } from "@cockpit-context/agent-runtime";
import {
  DefinitionRequest,
  type DocumentSymbol,
  DocumentSymbolRequest,
  HoverRequest,
  type Location,
  type LocationLink,
  type MarkedString,
  type MarkupContent,
  ReferencesRequest,
  type SymbolInformation,
  type WorkspaceSymbol,
  WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol/node";
import { z } from "zod";

import { isGitMetadataPath, resolveWithinRoot } from "../paths";
import { wrapUntrustedToolResult } from "../tools";
import type { LspClient } from "./client";
import { LspError } from "./client";
import { type DetectedLanguages, lspWorkspaceDir } from "./detect";
import type { LspManager } from "./manager";
import { type LanguageServerSpec, type LspLanguage, languageForPath } from "./specs";

/** Inline result budget for each LSP tool. */
const LSP_TOOL_MAX_RESULT_CHARS = 24_000;
/** Largest source file the tools open in a server. */
const MAX_LSP_FILE_BYTES = 1_000_000;
const DEFAULT_LOCATION_LIMIT = 50;
const MAX_LOCATION_LIMIT = 200;
const MAX_DOCUMENT_SYMBOLS = 300;
const MAX_HOVER_CHARS = 6_000;
const MAX_SNIPPET_CHARS = 200;
/** Snippets are read only from files up to this size. */
const MAX_SNIPPET_FILE_BYTES = 2_000_000;

export const LSP_TOOL_NAMES = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
] as const;

export type LspToolsOptions = {
  manager: LspManager;
  /** The checkout's id: the manager's key, and what `stopCheckout` stops. */
  checkoutId: string;
  /** Absolute path to the checkout (the explore root). */
  root: string;
  /** The package's subdirectory, root-relative, when it lives in one. */
  subdirectory?: string;
  /** Precomputed detection; detected from `root` when omitted. */
  languages?: DetectedLanguages;
};

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type parameter",
};

const kindName = (kind: number) => SYMBOL_KIND_NAMES[kind] ?? "symbol";

const FALLBACK_HINT = "Fall back to grep and read.";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the checkout's absolute path, and its `file:` URI, with `.` in
 * text a language server produced (hover, symbol details, error messages).
 * The servers see the checkout at its real path under the data dir; the model
 * and the user only ever see checkout-relative paths.
 */
export function redactCheckoutPaths(text: string, roots: readonly string[]): string {
  return createCheckoutPathRedactor(roots)(text);
}

/**
 * `redactCheckoutPaths` with the forms and their RegExps compiled once: the
 * tools redact every result and failure against the same roots.
 */
function createCheckoutPathRedactor(roots: readonly string[]): (text: string) => string {
  const forms = new Set<string>();
  for (const root of roots) {
    if (!root || root === "/") continue;
    forms.add(pathToFileURL(root).href);
    forms.add(root);
  }
  // Longest first, so a URI is replaced whole before its bare path.
  const patterns = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => new RegExp(`${escapeRegExp(form)}(?![\\w.-])`, "g"));
  return (text) => {
    let out = text;
    // `replace` resets a global RegExp's `lastIndex`, so sharing one is safe.
    for (const pattern of patterns) out = out.replace(pattern, ".");
    return out;
  };
}

/**
 * Reword any failure as a tool error the model can act on. Messages never
 * carry a host path: the root is replaced, and server-sent messages are
 * clipped.
 */
function toolFailure(tool: string, error: unknown, redact: (text: string) => string): Error {
  let reason: string;
  if (error instanceof LspError) {
    reason =
      error.kind === "timeout"
        ? "the language server did not answer in time"
        : error.kind === "crashed"
          ? "the language server stopped"
          : error.kind === "start"
            ? `the language server is unavailable (${error.message})`
            : error.kind === "aborted"
              ? "the call was aborted"
              : `the language server returned an error (${error.message.slice(0, 200)})`;
  } else {
    reason = error instanceof Error ? error.message : String(error);
  }
  reason = redact(reason);
  return new Error(`${tool} failed: ${reason}. ${FALLBACK_HINT}`);
}

type Position = { line: number; character: number };

type ResolvedLocation = { relative: string; absolute: string };

/** Distinct files a formatter reads at once while prefetching. */
const PREFETCH_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Renders server locations as checkout-relative `path:line:col  snippet`,
 * with the same realpath confinement as `read`: anything outside the checkout
 * (a symlink out of it included) is dropped and only counted. So is anything
 * in git metadata (`isGitMetadataPath`), which `read` refuses as well.
 *
 * `prefetch` resolves and reads the files a render will touch with
 * non-blocking fs calls, a few at a time; `format` then answers from those
 * caches, and resolves anything not prefetched synchronously, the same way.
 */
class LocationFormatter {
  private readonly resolved = new Map<string, ResolvedLocation | undefined>();
  private readonly lineCache = new Map<string, string[] | null>();
  outside = 0;

  constructor(private readonly rootReal: string) {}

  /** Warm the caches for `items`; snippet files are read only for items with a `start`. */
  async prefetch(items: ReadonlyArray<{ uri: string; start?: Position }>): Promise<void> {
    const wantsLines = new Map<string, boolean>();
    for (const item of items) {
      wantsLines.set(item.uri, wantsLines.get(item.uri) === true || item.start !== undefined);
    }
    const reading = new Map<string, Promise<void>>();
    await forEachLimited([...wantsLines], PREFETCH_CONCURRENCY, async ([uri, lines]) => {
      if (!this.resolved.has(uri)) this.resolved.set(uri, await this.resolveAsync(uri));
      const absolute = this.resolved.get(uri)?.absolute;
      if (!lines || absolute === undefined || this.lineCache.has(absolute)) return;
      // Two URIs can name one file; it is read once.
      let pending = reading.get(absolute);
      if (!pending) {
        pending = readLinesAsync(absolute).then((read) => {
          this.lineCache.set(absolute, read);
        });
        reading.set(absolute, pending);
      }
      await pending;
    });
  }

  /** The checkout-relative path of a `file:` URI, or undefined when outside it. */
  relative(uri: string): ResolvedLocation | undefined {
    if (this.resolved.has(uri)) return this.resolved.get(uri);
    let resolved: ResolvedLocation | undefined;
    if (uri.startsWith("file:")) {
      try {
        resolved = this.confine(fs.realpathSync.native(fileURLToPath(uri)));
      } catch {
        resolved = undefined;
      }
    }
    this.resolved.set(uri, resolved);
    return resolved;
  }

  private async resolveAsync(uri: string): Promise<ResolvedLocation | undefined> {
    if (!uri.startsWith("file:")) return undefined;
    try {
      return this.confine(await fs.promises.realpath(fileURLToPath(uri)));
    } catch {
      return undefined;
    }
  }

  private confine(absolute: string): ResolvedLocation | undefined {
    if (absolute !== this.rootReal && !absolute.startsWith(this.rootReal + path.sep)) {
      return undefined;
    }
    if (isGitMetadataPath(this.rootReal, absolute)) return undefined;
    return {
      relative: path.relative(this.rootReal, absolute).split(path.sep).join("/") || ".",
      absolute,
    };
  }

  format(uri: string, start?: Position): string | undefined {
    const resolved = this.relative(uri);
    if (!resolved) {
      this.outside += 1;
      return undefined;
    }
    if (!start) return resolved.relative;
    const where = `${resolved.relative}:${start.line + 1}:${start.character + 1}`;
    const snippet = this.snippet(resolved.absolute, start.line);
    return snippet ? `${where}  ${snippet}` : where;
  }

  private snippet(absolute: string, line: number): string | undefined {
    let lines = this.lineCache.get(absolute);
    if (lines === undefined) {
      lines = readLinesSync(absolute);
      this.lineCache.set(absolute, lines);
    }
    const text = lines?.[line]?.trim();
    if (!text) return undefined;
    return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text;
  }

  outsideNote(): string {
    return this.outside > 0
      ? `\n(${this.outside} result(s) outside the checkout omitted, e.g. standard library or bundled types)`
      : "";
  }
}

/** A snippet file's lines, or null when it is too large or unreadable. */
function readLinesSync(absolute: string): string[] | null {
  try {
    if (fs.statSync(absolute).size > MAX_SNIPPET_FILE_BYTES) return null;
    return fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

async function readLinesAsync(absolute: string): Promise<string[] | null> {
  try {
    if ((await fs.promises.stat(absolute)).size > MAX_SNIPPET_FILE_BYTES) return null;
    return (await fs.promises.readFile(absolute, "utf8")).split(/\r?\n/);
  } catch {
    return null;
  }
}

type Located = { uri: string; start: Position };

function normalizeDefinition(result: Location | Location[] | LocationLink[] | null): Located[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, start: item.targetSelectionRange.start }
      : { uri: item.uri, start: item.range.start },
  );
}

async function renderLocations(
  located: Located[],
  formatter: LocationFormatter,
  limit: number,
  empty: string,
): Promise<string> {
  const seen = new Set<string>();
  const unique: Located[] = [];
  for (const item of located) {
    const id = `${item.uri}:${item.start.line}:${item.start.character}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  // Formatted in order until `limit` lines are rendered; an omitted (outside)
  // location takes no line. Each batch is the slots still open, so no file is
  // prefetched that the render would not have touched.
  const lines: string[] = [];
  let index = 0;
  while (index < unique.length && lines.length < limit) {
    const batch = unique.slice(index, index + (limit - lines.length));
    index += batch.length;
    await formatter.prefetch(batch);
    for (const item of batch) {
      const line = formatter.format(item.uri, item.start);
      if (line) lines.push(line);
    }
  }
  const more = unique.length - index;
  if (lines.length === 0 && formatter.outside === 0) return empty;
  const header = `${lines.length} location(s)${more > 0 ? ` (${more} more not shown; raise limit or narrow down)` : ""}`;
  return [header, ...lines].join("\n") + formatter.outsideNote();
}

function hoverText(contents: MarkupContent | MarkedString | MarkedString[]): string {
  const part = (item: MarkedString) =>
    typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``;
  if (Array.isArray(contents)) return contents.map(part).join("\n\n");
  if (typeof contents === "string") return contents;
  if ("kind" in contents) return contents.value;
  return part(contents);
}

function renderDocumentSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null): string {
  if (!symbols || symbols.length === 0) return "No symbols found in this file.";
  const lines: string[] = [];
  let total = 0;
  const visit = (items: DocumentSymbol[], depth: number) => {
    for (const symbol of items) {
      total += 1;
      if (lines.length < MAX_DOCUMENT_SYMBOLS) {
        const at = `${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}`;
        const detail = symbol.detail ? ` — ${symbol.detail.slice(0, 120)}` : "";
        lines.push(`${"  ".repeat(depth)}${kindName(symbol.kind)} ${symbol.name}${detail} (${at})`);
      }
      if (symbol.children) visit(symbol.children, depth + 1);
    }
  };
  const first = symbols[0];
  if (first && "selectionRange" in first) {
    visit(symbols as DocumentSymbol[], 0);
  } else {
    for (const symbol of symbols as SymbolInformation[]) {
      total += 1;
      if (lines.length >= MAX_DOCUMENT_SYMBOLS) continue;
      const at = `${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`;
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      lines.push(`${kindName(symbol.kind)} ${symbol.name}${container} (${at})`);
    }
  }
  const more = total > lines.length ? `\n(${total - lines.length} more symbols not shown)` : "";
  return `${total} symbol(s) (line:col)\n${lines.join("\n")}${more}`;
}

async function renderWorkspaceSymbols(
  symbols: Array<SymbolInformation | WorkspaceSymbol>,
  formatter: LocationFormatter,
  limit: number,
): Promise<string[]> {
  const startOf = (symbol: SymbolInformation | WorkspaceSymbol) =>
    "range" in symbol.location ? symbol.location.range.start : undefined;
  const lines: string[] = [];
  // Batched like `renderLocations`: only the symbols the render reaches are prefetched.
  let index = 0;
  while (index < symbols.length && lines.length < limit) {
    const batch = symbols.slice(index, index + (limit - lines.length));
    index += batch.length;
    await formatter.prefetch(
      batch.map((symbol) => ({ uri: symbol.location.uri, start: startOf(symbol) })),
    );
    for (const symbol of batch) {
      const where = formatter.format(symbol.location.uri, startOf(symbol));
      if (!where) continue;
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      lines.push(`${kindName(symbol.kind)} ${symbol.name}${container} — ${where}`);
    }
  }
  return lines;
}

const positionSchema = {
  path: z.string().min(1).describe("File path relative to the explore root"),
  line: z.number().int().min(1).describe("1-based line, as `read` numbers it"),
  column: z.number().int().min(1).describe("1-based column of the symbol on that line"),
};

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LOCATION_LIMIT)
  .optional()
  .describe(`Max results (default ${DEFAULT_LOCATION_LIMIT})`);

/**
 * LSP tools over a checkout: definition, references, hover, workspace and
 * document symbols, backed by `manager`.
 *
 * Returns no tools when the manager is disabled (`COCKPIT_CONTEXT_LSP_MAX_SERVERS=0`, or
 * `COCKPIT_CONTEXT_LSP_SANDBOX=required` without a working Landlock sandbox) or the checkout has no
 * file of a supported language. All tools are
 * `untrusted: true` and fence their output. Every failure — no server for the
 * file type, a crash, a timeout — is a thrown tool error that tells the model
 * to use grep and read instead; it never fails the run.
 */
export function buildLspTools(options: LspToolsOptions): AgentTool[] {
  const { manager, checkoutId, root, subdirectory } = options;
  if (!manager.enabled) return [];
  const rootReal = resolveWithinRoot(root, ".");
  // Cached on the manager per checkout: a checkout's files never change.
  const detected: ReadonlyMap<LspLanguage, string> =
    options.languages ?? manager.detectLanguages(checkoutId, root);
  const languages = [...detected.keys()];
  if (languages.length === 0) return [];

  // Samples near the package's subdirectory, so the workspace-symbol project
  // load starts where the package lives.
  const samples = new Map(detected);
  if (subdirectory?.trim()) {
    try {
      for (const [language, sample] of manager.detectLanguages(checkoutId, root, subdirectory)) {
        samples.set(language, sample);
      }
    } catch {
      // Missing or escaping subdirectory: keep the root samples.
    }
  }

  const label = languages.map((language) => manager.specs[language].label).join(", ");
  // Both spellings of the checkout's path, for redaction.
  const redact = createCheckoutPathRedactor([...new Set([rootReal, path.resolve(root)])]);
  const workspaceDirs = new Map<LspLanguage, string>();
  const workspaceDirFor = (spec: LanguageServerSpec) => {
    let dir = workspaceDirs.get(spec.language);
    if (dir === undefined) {
      dir = lspWorkspaceDir(root, subdirectory, spec);
      workspaceDirs.set(spec.language, dir);
    }
    return dir;
  };

  const withServer = <T>(language: LspLanguage, fn: (client: LspClient) => Promise<T>) => {
    const spec = manager.specs[language];
    const workspaceDir = workspaceDirFor(spec);
    return manager.use(
      { checkoutId, language, workspaceDir },
      { checkoutRoot: rootReal, workspaceRoot: resolveWithinRoot(root, workspaceDir) },
      fn,
    );
  };

  /** Resolve a model path to an open document on its language's server. */
  const openFile = (
    client: LspClient,
    relativePath: string,
  ): { uri: string; absolute: string; spec: LanguageServerSpec } => {
    const absolute = resolveWithinRoot(root, relativePath);
    if (isGitMetadataPath(rootReal, absolute)) throw new Error(`Not found: ${relativePath}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new Error(`Not found: ${relativePath}`);
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
    if (stat.size > MAX_LSP_FILE_BYTES) throw new Error(`File too large: ${relativePath}`);
    const language = languageForPath(absolute, manager.specs);
    if (!language) throw new Error(`No language server handles ${relativePath}`);
    const spec = manager.specs[language];
    const languageId = spec.languageIds[path.extname(absolute).toLowerCase()] ?? language;
    const uri = client.openDocument(absolute, languageId, () => fs.readFileSync(absolute, "utf8"));
    return { uri, absolute, spec };
  };

  /** The language for a model path, refusing ones this checkout has no server for. */
  const languageOf = (relativePath: string): LspLanguage => {
    const language = languageForPath(relativePath, manager.specs);
    if (!language || !detected.has(language)) {
      throw new Error(
        `No language server for ${path.extname(relativePath) || relativePath} files here (LSP covers ${label})`,
      );
    }
    return language;
  };

  /** Any failure, synchronous or not, becomes a grep/read fallback tool error. */
  const guarded = async <T>(tool: string, body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      throw toolFailure(tool, error, redact);
    }
  };

  const positional = <T>(
    tool: string,
    input: { path: string; line: number; column: number },
    signal: AbortSignal,
    run: (client: LspClient, uri: string, position: Position, signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    guarded(tool, () =>
      withServer(languageOf(input.path), (client) => {
        const { uri } = openFile(client, input.path);
        return run(client, uri, { line: input.line - 1, character: input.column - 1 }, signal);
      }),
    );

  const fence = (tool: string, subject: string, body: string) =>
    wrapUntrustedToolResult(redact(body), `checkout:${tool}:${subject}`, LSP_TOOL_MAX_RESULT_CHARS);

  const requestOptions = (signal: AbortSignal) => ({
    timeoutMs: manager.requestTimeoutMs,
    signal,
  });

  const definitionTool = defineTool({
    name: "lsp_definition",
    description: `Go to the definition of the symbol at path:line:column via the language server (${label}). Returns \`path:line:col\` with that line's text. Use it to jump from a usage or an import to the real declaration instead of grepping for it.`,
    inputSchema: z.object(positionSchema),
    maxResultChars: LSP_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async (input, signal) => {
      const body = await positional(
        "lsp_definition",
        input,
        signal,
        async (client, uri, position, abort) => {
          const formatter = new LocationFormatter(rootReal);
          const result = await client.request(
            DefinitionRequest.type,
            { textDocument: { uri }, position },
            requestOptions(abort),
          );
          return renderLocations(
            normalizeDefinition(result),
            formatter,
            MAX_LOCATION_LIMIT,
            "No definition found at that position (check line/column against `read` output).",
          );
        },
      );
      return fence("lsp_definition", input.path, body);
    },
  });

  const referencesTool = defineTool({
    name: "lsp_references",
    description: `Find references to the symbol at path:line:column via the language server (${label}), declaration included. Returns \`path:line:col\` with each line's text. Use it to find real call sites and usage examples of an API.`,
    inputSchema: z.object({ ...positionSchema, limit: limitSchema }),
    maxResultChars: LSP_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async (input, signal) => {
      const body = await positional(
        "lsp_references",
        input,
        signal,
        async (client, uri, position, abort) => {
          const formatter = new LocationFormatter(rootReal);
          const result = await client.request(
            ReferencesRequest.type,
            { textDocument: { uri }, position, context: { includeDeclaration: true } },
            requestOptions(abort),
          );
          return renderLocations(
            (result ?? []).map((item) => ({ uri: item.uri, start: item.range.start })),
            formatter,
            input.limit ?? DEFAULT_LOCATION_LIMIT,
            "No references found at that position (check line/column against `read` output).",
          );
        },
      );
      return fence("lsp_references", input.path, body);
    },
  });

  const hoverTool = defineTool({
    name: "lsp_hover",
    description: `Type signature and doc comment of the symbol at path:line:column via the language server (${label}). Use it to confirm a parameter or return type without reading the declaration file.`,
    inputSchema: z.object(positionSchema),
    maxResultChars: LSP_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async (input, signal) => {
      const body = await positional(
        "lsp_hover",
        input,
        signal,
        async (client, uri, position, abort) => {
          const result = await client.request(
            HoverRequest.type,
            { textDocument: { uri }, position },
            requestOptions(abort),
          );
          const text = result ? hoverText(result.contents).trim() : "";
          if (!text) return "No hover information at that position.";
          return text.length > MAX_HOVER_CHARS
            ? `${text.slice(0, MAX_HOVER_CHARS)}\n…[truncated]`
            : text;
        },
      );
      return fence("lsp_hover", input.path, body);
    },
  });

  const documentSymbolsTool = defineTool({
    name: "lsp_document_symbols",
    description: `Outline of one file via the language server (${label}): its classes, functions, methods and variables with line:col. Cheaper than reading a long file to find a declaration.`,
    inputSchema: z.object({ path: positionSchema.path }),
    maxResultChars: LSP_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async (input, signal) => {
      const body = await guarded("lsp_document_symbols", () =>
        withServer(languageOf(input.path), async (client) => {
          const { uri } = openFile(client, input.path);
          const result = await client.request(
            DocumentSymbolRequest.type,
            { textDocument: { uri } },
            requestOptions(signal),
          );
          return renderDocumentSymbols(result);
        }),
      );
      return fence("lsp_document_symbols", input.path, body);
    },
  });

  const workspaceSymbolsTool = defineTool({
    name: "lsp_workspace_symbols",
    description: `Search declarations by name across the checkout via the language server (${label}). Returns kind, name and \`path:line:col\`. Use it to locate a class, function or type when you know (part of) its name.`,
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Symbol name or prefix"),
      limit: limitSchema,
    }),
    maxResultChars: LSP_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async ({ query, limit }, signal) => {
      const max = limit ?? DEFAULT_LOCATION_LIMIT;
      const formatter = new LocationFormatter(rootReal);
      const outcomes = await Promise.allSettled(
        languages.map((language) =>
          withServer(language, async (client) => {
            // Servers load a project when a file is opened; open a sample.
            const sample = samples.get(language);
            if (sample) openFile(client, sample);
            const result = await client.request(
              WorkspaceSymbolRequest.type,
              { query },
              requestOptions(signal),
            );
            return result ?? [];
          }),
        ),
      );
      const lines: string[] = [];
      const notes: string[] = [];
      for (const [index, outcome] of outcomes.entries()) {
        const language = languages[index];
        if (!language) continue;
        if (outcome.status === "fulfilled") {
          lines.push(
            ...(await renderWorkspaceSymbols(outcome.value, formatter, max - lines.length)),
          );
        } else {
          notes.push(
            `${manager.specs[language].label}: ${toolFailure("lsp_workspace_symbols", outcome.reason, redact).message}`,
          );
        }
      }
      if (lines.length === 0 && notes.length === languages.length) {
        throw new Error(notes.join("\n"));
      }
      const body = [
        lines.length > 0 ? `${lines.length} symbol(s)` : `No symbols match "${query}".`,
        ...lines,
      ].join("\n");
      return fence(
        "lsp_workspace_symbols",
        query,
        body + formatter.outsideNote() + (notes.length > 0 ? `\n${notes.join("\n")}` : ""),
      );
    },
  });

  return [definitionTool, referencesTool, hoverTool, workspaceSymbolsTool, documentSymbolsTool];
}
