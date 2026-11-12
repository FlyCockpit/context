/**
 * A scripted, OpenAI-compatible stand-in for OpenRouter's chat-completions
 * API, for development and UI testing only (scripts/fake-openrouter.ts runs
 * it; scripts/fake-openrouter.ts documents it). It never calls a real model.
 *
 * Every response is planned from the request alone (the server keeps no
 * state), so restarts, follow-ups and parallel runs all work:
 *
 * - **Investigation (master).** A few `glob` / `grep` / `read` calls that pick
 *   real paths from the repo map in the system prompt and from earlier tool
 *   results, an optional `delegate_explore`, then a streamed markdown answer
 *   that cites the files it read.
 * - **Helper** (`Focus: …` user message). One grep, one read, bullet findings.
 * - **Checkout summary** (the overview prompt). One glob, then a plain-text guide.
 * - **Synthesis** (a request without tools). The final answer from the transcript.
 * - **Steering.** A user message that arrives after the question is echoed in
 *   the next assistant text ("Noted your steering: …"), followed by a grep for
 *   its most specific word; "wrap up" / "answer now" / "stop" skip straight to
 *   the answer. The final answer lists every steering message it saw.
 *
 * Each response waits `stepDelayMs` before it starts and streams text in small
 * chunks, so live view, steering and stop can be exercised by hand.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Wire shapes (the subset of the OpenAI / OpenRouter chat-completions request
// this fake reads).
// ---------------------------------------------------------------------------

type WireContent = string | Array<{ type?: string; text?: string }> | null | undefined;

type WireToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type WireMessage = {
  role: string;
  content?: WireContent;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
};

export type WireChatRequest = {
  model?: string;
  messages?: WireMessage[];
  tools?: Array<{ type?: string; function?: { name?: string } }>;
  stream?: boolean;
};

type PlannedCall = { name: string; args: Record<string, unknown> };

/** One assistant response: optional text, then zero or more tool calls. */
export type PlannedStep = { text: string; calls: PlannedCall[] };

export type DelegateMode = "auto" | "always" | "never";

export type FakeOpenRouterOptions = {
  /** Pause before each response starts (default 1500 ms). */
  stepDelayMs?: number;
  /** Pause between streamed chunks (default 30 ms). */
  chunkDelayMs?: number;
  /**
   * When the master calls `delegate_explore`: `auto` (default) only when the
   * question mentions helpers, delegation, parallel work or a deep dive.
   */
  delegate?: DelegateMode;
  log?: (line: string) => void;
};

/** Prefix of the assistant text that acknowledges a steering message. */
export const STEERING_ECHO_PREFIX = "Noted your steering:";
/** The checkout-summary prompt's opening (packages/explore/src/summary.ts). */
const SUMMARY_PROMPT_START = "You are analyzing the repository for the package";
/** Helper briefs open with this (packages/explore/src/run-explore-agent.ts). */
const HELPER_PROMPT_START = "Focus:";
const DELEGATE_TOOL = "delegate_explore";
/** The force-final synthesis user message (packages/explore/src/prompts.ts) is not steering. */
const FORCE_FINAL_START = "The investigation budget ended.";
const SOURCE_GLOB = "**/*.{ts,tsx,js,mjs,cjs,py,rs,go}";
const WRAP_UP = /\b(wrap(?:\s|-)?up|answer now|finish now|stop (?:searching|exploring|now))\b/i;
const DELEGATE_HINT = /\b(delegate|delegation|helpers?|parallel|deep[\s-]?dive|in depth)\b/i;
/** Question text that makes the fake answer with an HTTP 503 (to test model errors). */
export const FAKE_ERROR_TRIGGER = "[fake:error]";

// ---------------------------------------------------------------------------
// Conversation analysis
// ---------------------------------------------------------------------------

type RepoMapLite = {
  languages: string[];
  entrypoints: string[];
  examplePaths: string[];
  docPaths: string[];
  topLevel: string[];
};

type ToolExchange = { name: string; args: Record<string, unknown>; result: unknown };

type Analysis = {
  mode: "master" | "helper" | "summary" | "synthesis";
  toolNames: Set<string>;
  packageId?: string;
  subdirectory?: string;
  repoMap?: RepoMapLite;
  question: string;
  /** Every steering message of the current exchange, in order. */
  steering: string[];
  /** Steering messages that arrived since the last assistant message. */
  newSteering: string[];
  /** Assistant tool-call steps of the current exchange that followed the plan. */
  planSteps: number;
  /** Every tool call (with its parsed result) in the whole conversation. */
  exchanges: ToolExchange[];
  /** Tool calls of the current exchange only. */
  current: ToolExchange[];
};

function contentText(content: WireContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Parse the JSON body of a tool result (unwrapping the untrusted-content fence). */
function parseToolResult(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // Not JSON (an error message, or a truncated body): keep the text.
    }
  }
  return raw;
}

function parseRepoMap(system: string): RepoMapLite | undefined {
  const match = /```json\n([\s\S]*?)\n```/.exec(system);
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const strings = (key: string): string[] =>
      Array.isArray(record[key])
        ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
    return {
      languages: strings("languages"),
      entrypoints: strings("entrypoints"),
      examplePaths: strings("examplePaths"),
      docPaths: strings("docPaths"),
      topLevel: strings("topLevel"),
    };
  } catch {
    // A map clipped at the prompt budget is not valid JSON; plan without it.
    return undefined;
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function analyzeRequest(request: WireChatRequest): Analysis {
  const messages = request.messages ?? [];
  const toolNames = new Set(
    (request.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentText(message.content))
    .join("\n\n");

  // Tool results by call id, then every call in order.
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      results.set(message.tool_call_id, parseToolResult(contentText(message.content)));
    }
  }
  const exchangesOf = (slice: WireMessage[]): ToolExchange[] =>
    slice.flatMap((message) =>
      message.role === "assistant"
        ? (message.tool_calls ?? []).map((call) => ({
            name: call.function?.name ?? "",
            args: parseArgs(call.function?.arguments),
            result: call.id ? results.get(call.id) : undefined,
          }))
        : [],
    );

  // The current exchange starts after the last assistant message that ended
  // a turn (text, no tool calls): earlier ones belong to previous runs of
  // the conversation (follow-up history).
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant" && !(message.tool_calls?.length ?? 0)) {
      start = index + 1;
      break;
    }
  }
  // A run that was stopped or interrupted never wrote a final answer, so a
  // follow-up after it looks exactly like steering. Convention: the last
  // trailing user message phrased as a question opens a new exchange.
  const last = messages[messages.length - 1];
  if (
    last?.role === "user" &&
    messages.length - 1 > start &&
    contentText(last.content).trim().endsWith("?") &&
    messages.slice(start, -1).some((message) => message.role === "assistant")
  ) {
    start = messages.length - 1;
  }
  const segment = messages.slice(start);
  const userTexts = segment
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content).trim())
    .filter((text) => !text.startsWith(FORCE_FINAL_START));
  const question = userTexts[0] ?? "";
  const steering = userTexts.slice(1);

  let lastAssistant = -1;
  segment.forEach((message, index) => {
    if (message.role === "assistant") lastAssistant = index;
  });
  // Steering sent while the run was still preparing reaches the first dispatch.
  const newSteering =
    lastAssistant === -1
      ? steering
      : segment
          .slice(lastAssistant + 1)
          .filter((message) => message.role === "user")
          .map((message) => contentText(message.content).trim())
          .filter((text) => !text.startsWith(FORCE_FINAL_START));

  const planSteps = segment.filter(
    (message) =>
      message.role === "assistant" &&
      (message.tool_calls?.length ?? 0) > 0 &&
      !contentText(message.content).startsWith(STEERING_ECHO_PREFIX),
  ).length;

  const mode: Analysis["mode"] = question.startsWith(SUMMARY_PROMPT_START)
    ? "summary"
    : toolNames.size === 0
      ? "synthesis"
      : question.startsWith(HELPER_PROMPT_START)
        ? "helper"
        : "master";

  return {
    mode,
    toolNames,
    packageId: /^- Package: (.+)$/m.exec(system)?.[1]?.trim(),
    subdirectory: /Subdirectory focus: `([^`]+)`/.exec(system)?.[1]?.trim(),
    repoMap: parseRepoMap(system),
    question,
    steering,
    newSteering,
    planSteps,
    exchanges: exchangesOf(messages),
    current: exchangesOf(segment),
  };
}

// ---------------------------------------------------------------------------
// Evidence helpers: what earlier tool calls returned.
// ---------------------------------------------------------------------------

function globMatches(exchanges: ToolExchange[]): string[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.name !== "glob") return [];
    const result = exchange.result as { matches?: unknown } | undefined;
    return Array.isArray(result?.matches)
      ? result.matches.filter((item): item is string => typeof item === "string")
      : [];
  });
}

type GrepHit = { path: string; line: number; text: string };

function grepHits(exchanges: ToolExchange[]): GrepHit[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.name !== "grep") return [];
    const result = exchange.result as { matches?: unknown } | undefined;
    if (!Array.isArray(result?.matches)) return [];
    return result.matches.flatMap((item): GrepHit[] => {
      const hit = item as Partial<GrepHit>;
      return typeof hit.path === "string" && typeof hit.line === "number"
        ? [{ path: hit.path, line: hit.line, text: String(hit.text ?? "").trim() }]
        : [];
    });
  });
}

type ReadEvidence = { path: string; lines: Array<{ line: number; text: string }> };

function readFiles(exchanges: ToolExchange[]): ReadEvidence[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.name !== "read") return [];
    const result = exchange.result as { path?: unknown; content?: unknown } | undefined;
    if (typeof result?.path !== "string" || typeof result.content !== "string") return [];
    const lines = result.content.split("\n").flatMap((row) => {
      const bar = row.indexOf("|");
      const line = Number(row.slice(0, bar));
      return bar > 0 && Number.isInteger(line) ? [{ line, text: row.slice(bar + 1) }] : [];
    });
    return [{ path: result.path, lines }];
  });
}

function delegateReports(exchanges: ToolExchange[]): string[] {
  return exchanges.flatMap((exchange) =>
    exchange.name === DELEGATE_TOOL && typeof exchange.result === "string"
      ? [exchange.result]
      : exchange.name === DELEGATE_TOOL && exchange.result !== undefined
        ? [JSON.stringify(exchange.result)]
        : [],
  );
}

const isReadme = (file: string) => /(^|\/)readme(\.[a-z]+)?$/i.test(file);
const isSource = (file: string) => /\.(ts|tsx|js|mjs|cjs|py|rs|go)$/.test(file);
const isTest = (file: string) =>
  /(^|\/)(tests?|__tests__|spec|fixtures?)\//.test(file) || /\.(test|spec)\./.test(file);
const isDeclaration = (file: string) => /\.d\.[cm]?ts$/.test(file);
const isExample = (file: string) => /(^|\/)(examples?|demos?|docs?)\//.test(file);
const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

function language(analysis: Analysis): string {
  const fromMap = analysis.repoMap?.languages[0]?.toLowerCase();
  if (fromMap) return fromMap;
  const sources = globMatches(analysis.exchanges).filter(isSource);
  const ext = sources[0]?.split(".").pop() ?? "";
  if (ext === "py") return "python";
  if (ext === "rs") return "rust";
  if (ext === "go") return "go";
  return "typescript";
}

function exportPattern(lang: string): string {
  if (lang.includes("python")) return "^(def|class) [A-Za-z]";
  if (lang.includes("rust")) return "^pub (fn|struct|enum|trait) ";
  if (lang.includes("go")) return "^func [A-Z]";
  return "^export |module\\.exports|exports\\.";
}

/** The most promising entry source file: repo-map entrypoints first, then globbed sources. */
function entryFile(analysis: Analysis): string | undefined {
  const sources = globMatches(analysis.exchanges).filter(isSource);
  const library = sources.filter((file) => !isTest(file) && !isExample(file));
  const preferred = [
    ...(analysis.repoMap?.entrypoints ?? []).filter(isSource),
    ...library.filter((file) => /(^|\/)(index|main|lib|mod|__init__)\.[a-z]+$/.test(file)),
    ...library.filter((file) => /^(src|lib|packages|crates)\//.test(file)),
    ...library,
    ...sources,
  ];
  const sub = analysis.subdirectory;
  return (
    (sub ? preferred.find((file) => file.startsWith(`${sub}/`)) : undefined) ??
    preferred.find((file) => !isDeclaration(file)) ??
    preferred[0]
  );
}

function readmeFile(analysis: Analysis): string | undefined {
  const candidates = [
    ...(analysis.repoMap?.entrypoints ?? []).filter(isReadme),
    ...globMatches(analysis.exchanges).filter(isReadme),
  ];
  const sub = analysis.subdirectory;
  return (sub ? candidates.find((file) => file.startsWith(`${sub}/`)) : undefined) ?? candidates[0];
}

/** The most specific word of a free-text instruction (for a grep). */
export function keywordOf(text: string): string {
  const code = /`([^`\s]{3,})`/.exec(text)?.[1];
  if (code) return code;
  const words = text.match(/[A-Za-z_$][\w$.-]{2,}/g) ?? [];
  const stop = new Set([
    "the",
    "and",
    "how",
    "what",
    "does",
    "with",
    "that",
    "this",
    "from",
    "into",
    "about",
    "please",
    "focus",
    "look",
    "instead",
    "should",
    "would",
    "could",
    "use",
    "using",
    "used",
    "helper",
    "helpers",
    "deep",
    "dive",
    "parallel",
    "delegate",
    "example",
    "examples",
    "option",
    "options",
    "include",
    "function",
    "package",
    "library",
    "there",
    "when",
    "where",
    "which",
    "find",
    "show",
    "documented",
    "implementation",
    "usage",
  ]);
  const ranked = words
    .map((word) => word.replace(/[.-]+$/, ""))
    .filter((word) => !stop.has(word.toLowerCase()))
    .sort((a, b) => codeLike(b) - codeLike(a) || b.length - a.length);
  return ranked[0] ?? "export";
}

/** 1 for words that look like identifiers (camelCase, snake_case, dotted). */
const codeLike = (word: string) => (/[a-z][A-Z]|_|\./.test(word) ? 1 : 0);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function withPath(args: Record<string, unknown>, path: string | undefined) {
  return path ? { ...args, path } : args;
}

function steeringStep(analysis: Analysis): PlannedStep | undefined {
  if (analysis.mode !== "master" || analysis.newSteering.length === 0) return undefined;
  const latest = analysis.newSteering[analysis.newSteering.length - 1] ?? "";
  const quoted = analysis.newSteering.map((text) => `“${text}”`).join(" and ");
  if (WRAP_UP.test(latest)) return undefined; // the final answer echoes it
  const keyword = keywordOf(latest);
  return {
    text: `${STEERING_ECHO_PREFIX} ${quoted}. Adjusting the search — grepping for \`${keyword}\` next.`,
    calls: [
      {
        name: "grep",
        args: withPath(
          { pattern: escapeRegExp(keyword), case_insensitive: true, max_matches: 20 },
          analysis.subdirectory,
        ),
      },
    ],
  };
}

function wantsDelegation(analysis: Analysis, delegate: DelegateMode): boolean {
  if (!analysis.toolNames.has(DELEGATE_TOOL)) return false;
  if (analysis.current.some((exchange) => exchange.name === DELEGATE_TOOL)) return false;
  if (delegate === "never") return false;
  return delegate === "always" || DELEGATE_HINT.test(analysis.question);
}

/** The LSP tool the master calls next to its reads, and the files it handles. */
const LSP_OUTLINE_TOOL = "lsp_document_symbols";
const LSP_SOURCE = /\.(?:[cm]?[jt]sx?|pyi?)$/i;

function masterStep(analysis: Analysis, delegate: DelegateMode): PlannedStep {
  const sub = analysis.subdirectory;
  const wrapUp = analysis.steering.some((text) => WRAP_UP.test(text));
  if (!wrapUp) {
    const steer = steeringStep(analysis);
    if (steer) return steer;
    const lang = language(analysis);
    switch (analysis.planSteps) {
      case 0:
        return {
          text: `I'll start from the repo map: the README first, then the public entry points${sub ? ` under \`${sub}\`` : ""}.`,
          calls: [
            { name: "glob", args: withPath({ pattern: "**/README*" }, sub) },
            { name: "glob", args: withPath({ pattern: SOURCE_GLOB }, sub) },
          ],
        };
      case 1: {
        const entry = entryFile(analysis);
        const dir = entry ? dirOf(entry) : sub;
        const keyword = keywordOf(analysis.question);
        return {
          text: `Searching for the exported API${dir ? ` in \`${dir}\`` : ""} and for \`${keyword}\`.`,
          calls: [
            {
              name: "grep",
              args: withPath({ pattern: exportPattern(lang), max_matches: 30 }, dir || undefined),
            },
            {
              name: "grep",
              args: withPath(
                { pattern: escapeRegExp(keyword), case_insensitive: true, max_matches: 20 },
                sub,
              ),
            },
          ],
        };
      }
      case 2: {
        const hits = grepHits(analysis.current).filter(
          (hit) => isSource(hit.path) && !isTest(hit.path) && !isExample(hit.path),
        );
        const entry =
          hits.find((hit) => !isDeclaration(hit.path))?.path ??
          hits[0]?.path ??
          entryFile(analysis);
        const readme = readmeFile(analysis);
        const calls: PlannedCall[] = [];
        if (entry) calls.push({ name: "read", args: { path: entry, limit: 120 } });
        if (readme && readme !== entry)
          calls.push({ name: "read", args: { path: readme, limit: 80 } });
        // When the LSP tools are offered (a sandboxed language server is
        // available for this checkout), outline the entry file through one.
        if (entry && analysis.toolNames.has(LSP_OUTLINE_TOOL) && LSP_SOURCE.test(entry)) {
          calls.push({ name: LSP_OUTLINE_TOOL, args: { path: entry } });
        }
        if (calls.length > 0) {
          return {
            text: "Reading the most promising files to confirm the real signatures.",
            calls,
          };
        }
        break;
      }
      case 3:
        if (wantsDelegation(analysis, delegate)) {
          const docs = readmeFile(analysis) ?? analysis.repoMap?.docPaths[0] ?? "README.md";
          const entry = entryFile(analysis);
          const src = (entry ? dirOf(entry) : sub) || analysis.repoMap?.topLevel[0] || ".";
          return {
            text: "The question spans docs and source; I'll send two helpers in parallel.",
            calls: [
              {
                name: DELEGATE_TOOL,
                args: {
                  agents: [
                    {
                      focus: docs,
                      question: `Find the documented usage example for: ${analysis.question}`,
                    },
                    {
                      focus: src,
                      question: `Find the implementation and its options for: ${analysis.question}`,
                    },
                  ],
                },
              },
            ],
          };
        }
        break;
      default:
        break;
    }
  }
  return { text: finalAnswer(analysis), calls: [] };
}

function helperStep(analysis: Analysis): PlannedStep {
  const focus = /^Focus: (.+)$/m.exec(analysis.question)?.[1]?.trim() ?? "";
  const focusPath = /^[\w./@-]+$/.test(focus) && focus !== "." ? focus : undefined;
  if (analysis.planSteps === 0) {
    const brief = analysis.question
      .split("\n")
      .slice(1)
      .filter((line) => !line.startsWith("Return bullet findings"))
      .join(" ");
    return {
      text: `Looking under \`${focusPath ?? "."}\`.`,
      calls: [
        {
          name: "grep",
          args: withPath(
            { pattern: escapeRegExp(keywordOf(brief)), case_insensitive: true, max_matches: 10 },
            focusPath && !isReadme(focusPath) ? focusPath : undefined,
          ),
        },
      ],
    };
  }
  if (analysis.planSteps === 1) {
    const hit = grepHits(analysis.current)[0];
    const target = hit?.path ?? (focusPath && /\.[a-z]+$/i.test(focusPath) ? focusPath : undefined);
    if (target) {
      return {
        text: "",
        calls: [
          {
            name: "read",
            args: { path: target, offset: Math.max(1, (hit?.line ?? 1) - 10), limit: 60 },
          },
        ],
      };
    }
  }
  return { text: helperFindings(analysis, focus), calls: [] };
}

function helperFindings(analysis: Analysis, focus: string): string {
  const findings = [
    ...grepHits(analysis.current)
      .slice(0, 4)
      .map((hit) => `- \`${hit.path}:${hit.line}\` — \`${clip(hit.text, 90)}\``),
    ...readFiles(analysis.current)
      .slice(0, 1)
      .map((file) => `- Read \`${file.path}:${file.lines[0]?.line ?? 1}-${lastLine(file)}\``),
  ];
  return findings.length > 0
    ? `Findings for ${focus || "the brief"}:\n${findings.join("\n")}`
    : `- Nothing matched under \`${focus || "."}\`; searched with grep.`;
}

function summaryStep(analysis: Analysis): PlannedStep {
  if (analysis.planSteps === 0 && analysis.toolNames.has("glob")) {
    return {
      text: "",
      calls: [{ name: "glob", args: { pattern: "**/*.{md,json,toml,ts,js,py,rs,go}" } }],
    };
  }
  const files = globMatches(analysis.exchanges).filter((file) => !isTest(file));
  const name = /for the package "([^"]+)"/.exec(analysis.question)?.[1] ?? "this package";
  const key = files.filter((file) => isSource(file) || isReadme(file)).slice(0, 6);
  const config = files.filter((file) => /\.(json|toml)$/.test(file)).slice(0, 3);
  return {
    text: [
      `1. ${name} is a small library; this overview was written by the Cockpit Context fake OpenRouter from the file list, not by a real model.`,
      `2. Key files: ${key.length > 0 ? key.map((file) => `\`${file}\``).join(", ") : "none listed"}.`,
      `3. Entry point: ${entryFile(analysis) ? `\`${entryFile(analysis)}\`` : "unknown"}; start there and follow its exports.`,
      "4. Conventions: one module per feature with colocated tests (unverified).",
      `5. Configuration: ${config.length > 0 ? config.map((file) => `\`${file}\``).join(", ") : "none found"}.`,
    ].join("\n"),
    calls: [],
  };
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const lastLine = (file: ReadEvidence) => file.lines[file.lines.length - 1]?.line ?? 1;

/** The streamed markdown answer: cites what the tools actually returned. */
function finalAnswer(analysis: Analysis): string {
  const evidence = analysis.exchanges;
  const reads = readFiles(evidence);
  const hits = grepHits(evidence)
    .filter((hit) => !isTest(hit.path))
    .sort((a, b) => Number(isSource(b.path)) - Number(isSource(a.path)));
  const pkg = analysis.packageId ?? "this package";
  const exportOf = (file: ReadEvidence) =>
    file.lines.find((row) =>
      /^(export |module\.exports|def |class |pub |func )/.test(row.text.trim()),
    );
  const primary =
    reads.find((file) => isSource(file.path) && !isDeclaration(file.path) && exportOf(file)) ??
    reads.find((file) => isSource(file.path) && exportOf(file)) ??
    reads.find((file) => isSource(file.path)) ??
    reads[0];
  const exportLine = primary ? exportOf(primary) : undefined;
  const lines: string[] = [];

  if (primary && exportLine) {
    lines.push(
      `**Short answer:** in \`${pkg}\` the public API starts at \`${primary.path}:${exportLine.line}\`: \`${clip(exportLine.text.trim(), 100)}\`.`,
    );
  } else if (primary) {
    lines.push(
      `**Short answer:** the closest evidence is \`${primary.path}:${primary.lines[0]?.line ?? 1}-${lastLine(primary)}\`; it does not show an export directly.`,
    );
  } else if (hits[0]) {
    lines.push(
      `**Short answer:** the closest match is \`${hits[0].path}:${hits[0].line}\`: \`${clip(hits[0].text, 100)}\`.`,
    );
  } else {
    lines.push(
      `**Short answer:** I could not find this in \`${pkg}\`'s source. I searched with ${analysis.exchanges.map((exchange) => exchange.name).join(", ") || "no tools"}.`,
    );
  }

  const cited = [
    ...reads.map(
      (file) => `- \`${file.path}:${file.lines[0]?.line ?? 1}-${lastLine(file)}\` — read`,
    ),
    ...hits.slice(0, 5).map((hit) => `- \`${hit.path}:${hit.line}\` — \`${clip(hit.text, 80)}\``),
  ];
  if (cited.length > 0) lines.push("", "### Where this comes from", ...cited);

  if (primary && exportLine) {
    const lang = language(analysis);
    const fence = lang.includes("python") ? "python" : lang.includes("rust") ? "rust" : "ts";
    lines.push("", "### Excerpt", `\`\`\`${fence}`);
    const from = primary.lines.findIndex((row) => row.line === exportLine.line);
    for (const row of primary.lines.slice(Math.max(0, from), from + 8)) lines.push(row.text);
    lines.push("```");
  }

  const reports = delegateReports(analysis.current);
  if (reports.length > 0) {
    const bullets = reports
      .flatMap((report) => report.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- `"))
      .slice(0, 4);
    lines.push(
      "",
      "### Helper reports",
      ...(bullets.length > 0
        ? bullets
        : ["- The helpers found nothing beyond the citations above."]),
    );
  }

  if (analysis.steering.length > 0) {
    lines.push(
      "",
      "### Your guidance",
      ...analysis.steering.map((text) => `- Applied: “${clip(text, 160)}”`),
    );
  }

  lines.push("", "_Scripted answer from the Cockpit Context fake OpenRouter — not a real model._");
  return lines.join("\n");
}

/** Plan the next assistant response for a chat-completions request. */
export function planResponse(
  request: WireChatRequest,
  options: { delegate?: DelegateMode } = {},
): PlannedStep {
  const analysis = analyzeRequest(request);
  switch (analysis.mode) {
    case "summary":
      return summaryStep(analysis);
    case "helper":
      return helperStep(analysis);
    case "synthesis":
      // A helper that ran out of budget synthesizes its findings, not an answer.
      return analysis.question.startsWith(HELPER_PROMPT_START)
        ? {
            text: helperFindings(
              analysis,
              /^Focus: (.+)$/m.exec(analysis.question)?.[1]?.trim() ?? "",
            ),
            calls: [],
          }
        : { text: finalAnswer(analysis), calls: [] };
    default:
      return masterStep(analysis, options.delegate ?? "auto");
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function usageFor(request: WireChatRequest, step: PlannedStep) {
  const prompt = estimateTokens(JSON.stringify(request.messages ?? []));
  const completion = estimateTokens(step.text + JSON.stringify(step.calls));
  // A few cached tokens after the first dispatch, as a prefix cache would give.
  const cached = (request.messages?.length ?? 0) > 2 ? Math.floor(prompt * 0.6) : 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    // $0.50 / M input, $2.00 / M output: small, realistic-looking numbers.
    cost: Number(((prompt * 0.5 + completion * 2) / 1_000_000).toFixed(8)),
  };
}

function textChunks(text: string): string[] {
  return (
    text.match(/\S+\s*|\s+/g)?.reduce<string[]>((chunks, word, index) => {
      if (index % 3 === 0) chunks.push(word);
      else chunks[chunks.length - 1] += word;
      return chunks;
    }, []) ?? [text]
  );
}

const newId = (prefix: string) => `${prefix}${randomBytes(9).toString("base64url")}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 32 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createFakeOpenRouterServer(options: FakeOpenRouterOptions = {}): Server {
  const stepDelayMs = options.stepDelayMs ?? 1_500;
  const chunkDelayMs = options.chunkDelayMs ?? 30;
  const log = options.log ?? (() => {});

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        sendJson(res, 200, { data: [{ id: "fake/model", name: "Cockpit Context fake model" }] });
        return;
      }
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        sendJson(res, 404, { error: { code: 404, message: "Not found" } });
        return;
      }
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        sendJson(res, 401, { error: { code: 401, message: "Missing bearer token" } });
        return;
      }

      let request: WireChatRequest;
      try {
        request = JSON.parse(await readBody(req)) as WireChatRequest;
      } catch {
        sendJson(res, 400, { error: { code: 400, message: "Invalid JSON body" } });
        return;
      }
      const analysis = analyzeRequest(request);
      if (analysis.question.includes(FAKE_ERROR_TRIGGER)) {
        log(`[fake-openrouter] ${FAKE_ERROR_TRIGGER} → 503`);
        sendJson(res, 503, { error: { code: 503, message: "Fake upstream unavailable" } });
        return;
      }

      const step = planResponse(request, { delegate: options.delegate });
      const model = request.model ?? "fake/model";
      log(
        `[fake-openrouter] ${analysis.mode} step ${analysis.planSteps}${analysis.newSteering.length > 0 ? " (steered)" : ""} → ${
          step.calls.length > 0 ? step.calls.map((call) => call.name).join(", ") : "final text"
        }`,
      );

      const aborted = new AbortController();
      res.on("close", () => aborted.abort());
      await sleep(stepDelayMs, aborted.signal);
      if (aborted.signal.aborted) return;

      const id = newId("gen-fake-");
      const created = Math.floor(Date.now() / 1_000);
      const calls = step.calls.map((call) => ({
        id: newId("call_"),
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      const finishReason = calls.length > 0 ? "tool_calls" : "stop";
      const usage = usageFor(request, step);

      if (!request.stream) {
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          system_fingerprint: null,
          choices: [
            {
              index: 0,
              finish_reason: finishReason,
              message: {
                role: "assistant",
                content: step.text || null,
                ...(calls.length > 0 ? { tool_calls: calls } : {}),
              },
            },
          ],
          usage,
        });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`,
        );
      const delta = (value: Record<string, unknown>, finish: string | null = null) =>
        send([{ index: 0, delta: value, finish_reason: finish }]);

      delta({ role: "assistant", content: "" });
      for (const chunk of step.text ? textChunks(step.text) : []) {
        if (aborted.signal.aborted) return;
        delta({ content: chunk });
        await sleep(chunkDelayMs, aborted.signal);
      }
      for (const [index, call] of calls.entries()) {
        if (aborted.signal.aborted) return;
        const args = call.function.arguments;
        const half = Math.ceil(args.length / 2);
        delta({
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.function.name, arguments: "" },
            },
          ],
        });
        delta({ tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] });
        await sleep(chunkDelayMs, aborted.signal);
        delta({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] });
      }
      if (aborted.signal.aborted) return;
      delta({}, finishReason);
      send([], { usage });
      res.write("data: [DONE]\n\n");
      res.end();
    })().catch((error: unknown) => {
      log(
        `[fake-openrouter] request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: 500, message: "Fake server error" } });
      else res.end();
    });
  });
}
