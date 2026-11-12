import type { AppRouterClient } from "@cockpit-context/api/routers/index";

import { describeResolvedFrom } from "./packages";

/**
 * Client-side model of the conversation screens (docs/product.md): the live view state folded from `conversations.watch`, the
 * transcript blocks it renders, tool-call summaries, and display helpers.
 * Everything here is pure so it is unit-tested (docs/development.md); the
 * hooks and components only wire it to the network and the DOM.
 *
 * All text that reaches these functions — questions, answers, tool
 * arguments and outputs, helper focuses — is untrusted (model-written, or
 * read from a checkout). It is only ever rendered as text or as markdown
 * without raw HTML (`Markdown`).
 */

type Client = AppRouterClient;
export type ConversationListItem = Awaited<
  ReturnType<Client["conversations"]["list"]>
>["items"][number];
export type ConversationDetail = Awaited<ReturnType<Client["conversations"]["get"]>>;
type DetailRun = ConversationDetail["runs"][number];
type IteratorValue<I> = I extends AsyncIterable<infer T> ? T : never;
export type WatchEvent = IteratorValue<Awaited<ReturnType<Client["conversations"]["watch"]>>>;
export type ActivityEvent = IteratorValue<Awaited<ReturnType<Client["conversations"]["activity"]>>>;
type SnapshotEvent = Extract<WatchEvent, { type: "snapshot" }>;
type LiveRunState = SnapshotEvent["live"]["runs"][number];

export type MessagePart = DetailRun["turns"][number]["parts"][number];
type LiveMessage = NonNullable<LiveRunState["partial"]>;
export type RunStatus = DetailRun["status"];
type RunKind = DetailRun["kind"];
type RunPhase = LiveRunState["phase"];
export type RunUsage = DetailRun["usage"];

interface TurnItem {
  seq: number;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  steering: boolean;
}

export interface RunView {
  id: string;
  parentRunId: string | null;
  kind: RunKind;
  status: RunStatus;
  trigger: string | null;
  focus: string | null;
  stopReason: string | null;
  iterations: number;
  usage: RunUsage;
  answer: string | null;
  /** Saved turns, ascending by `seq`, one per `seq`. */
  turns: TurnItem[];
  /** The in-flight assistant message (live only). */
  partial: LiveMessage | null;
  /** Finer than `status` while the run is live in the server process. */
  phase: RunPhase | null;
  /** 0-based helper index across the parent run's `delegate_explore` calls (live only). */
  helperIndex: number | null;
}

type ConversationMeta = Omit<ConversationDetail, "runs" | "truncated">;

export interface ConversationViewState {
  conversation: ConversationMeta;
  /** Runs in creation order (a run first seen live is appended). */
  runs: RunView[];
  truncated: boolean;
  /** Persisted cost of older runs outside the transcript window. */
  unloadedCostUsdMicros: number;
}

const ZERO_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsdMicros: 0,
};

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running"]);

export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

// ── Folding the watch stream ──

function runFromDetail(run: DetailRun): RunView {
  return {
    id: run.id,
    parentRunId: run.parentRunId,
    kind: run.kind,
    status: run.status,
    trigger: run.trigger,
    focus: run.focus,
    stopReason: run.stopReason,
    iterations: run.iterations,
    usage: run.usage,
    answer: run.answer,
    turns: [...run.turns]
      .sort((a, b) => a.seq - b.seq)
      .map((turn) => ({
        seq: turn.seq,
        role: turn.role,
        parts: turn.parts,
        steering: turn.steering,
      })),
    partial: null,
    phase: null,
    helperIndex: null,
  };
}

/** A run first heard of through a live event (a follow-up, a new helper). */
function placeholderRun(runId: string, parentRunId: string | null): RunView {
  return {
    id: runId,
    parentRunId,
    kind: parentRunId ? "helper" : "main",
    status: parentRunId ? "running" : "queued",
    trigger: null,
    focus: null,
    stopReason: null,
    iterations: 0,
    usage: ZERO_USAGE,
    answer: null,
    turns: [],
    partial: null,
    phase: null,
    helperIndex: null,
  };
}

/** The view state a `snapshot` describes: saved rows, overlaid with the engine's live state. */
function stateFromSnapshot(event: SnapshotEvent): ConversationViewState {
  const { runs, truncated, ...conversation } = event.conversation;
  const live = new Map(event.live.runs.map((run) => [run.runId, run]));
  const views = runs.map((run) => {
    const view = runFromDetail(run);
    const current = live.get(run.id);
    if (!current) return view;
    return {
      ...view,
      phase: current.phase,
      iterations: Math.max(view.iterations, current.iterations),
      usage: current.usage,
      partial: current.partial,
    };
  });
  for (const current of live.values()) {
    if (views.some((run) => run.id === current.runId)) continue;
    views.push({
      ...placeholderRun(current.runId, current.parentRunId),
      kind: current.kind,
      status: current.phase === "preparing" || current.phase === "queued" ? "queued" : "running",
      phase: current.phase,
      iterations: current.iterations,
      usage: current.usage,
      partial: current.partial,
    });
  }
  const unloadedCostUsdMicros = Math.max(
    0,
    conversation.totalCostUsdMicros - runs.reduce((sum, run) => sum + run.usage.costUsdMicros, 0),
  );
  return { conversation, runs: views, truncated, unloadedCostUsdMicros };
}

function updateRun(
  state: ConversationViewState,
  runId: string,
  parentRunId: string | null,
  update: (run: RunView) => RunView,
): ConversationViewState {
  const index = state.runs.findIndex((run) => run.id === runId);
  const runs = [...state.runs];
  if (index === -1) runs.push(update(placeholderRun(runId, parentRunId)));
  else runs[index] = update(runs[index] as RunView);
  return { ...state, runs };
}

function insertTurn(turns: TurnItem[], turn: TurnItem): TurnItem[] {
  // A turn can arrive in the snapshot and again as an event: dedupe by seq.
  if (turns.some((existing) => existing.seq === turn.seq)) return turns;
  return [...turns, turn].sort((a, b) => a.seq - b.seq);
}

/**
 * Fold one `conversations.watch` event into the view. A snapshot replaces
 * the state (it is sent first on every (re)subscription); every other event
 * needs a state to apply to and is dropped without one.
 */
export function applyWatchEvent(
  state: ConversationViewState | null,
  event: WatchEvent,
): ConversationViewState | null {
  if (event.type === "snapshot") return stateFromSnapshot(event);
  if (!state) return null;
  switch (event.type) {
    case "run.started":
      return updateRun(state, event.runId, null, (run) => ({
        ...run,
        kind: event.kind,
        status: "running",
      }));
    case "run.phase": {
      const next = updateRun(state, event.runId, null, (run) => ({
        ...run,
        phase: event.phase,
        status: event.phase === "running" || event.phase === "finishing" ? "running" : run.status,
      }));
      // Past `preparing`, the checkout exists again (a pruned one was re-created).
      if (event.phase === "preparing" || next.conversation.checkoutAvailable) return next;
      return { ...next, conversation: { ...next.conversation, checkoutAvailable: true } };
    }
    case "turn":
      return updateRun(state, event.runId, event.parentRunId ?? null, (run) => ({
        ...run,
        turns: insertTurn(run.turns, {
          seq: event.turn.seq,
          role: event.turn.role,
          parts: event.turn.parts,
          steering: event.turn.steering,
        }),
        // The saved assistant turn is the message that was streaming.
        partial: event.turn.role === "assistant" ? null : run.partial,
      }));
    case "delta":
      return updateRun(state, event.runId, event.parentRunId ?? null, (run) => ({
        ...run,
        partial: event.message,
      }));
    case "run.progress":
      return updateRun(state, event.runId, event.parentRunId ?? null, (run) => ({
        ...run,
        iterations: event.iterations,
        usage: event.usage,
      }));
    case "helper.started":
      return updateRun(state, event.runId, event.parentRunId, (run) => ({
        ...run,
        kind: "helper",
        parentRunId: event.parentRunId,
        status: "running",
        focus: event.focus,
        helperIndex: event.index,
      }));
    case "run.finished":
      return updateRun(state, event.runId, event.parentRunId ?? null, (run) => ({
        ...run,
        status: event.status,
        stopReason: event.stopReason,
        answer: event.answer,
        phase: null,
        // A stopped run keeps what was streaming; a finished one saved it as a turn.
        partial: event.status === "completed" ? null : run.partial,
      }));
    default:
      return state;
  }
}

// ── Selectors ──

function mainRuns(state: ConversationViewState): RunView[] {
  return state.runs.filter((run) => run.kind === "main");
}

export function latestMainRun(state: ConversationViewState): RunView | null {
  return mainRuns(state).at(-1) ?? null;
}

/** Usage over every run of the conversation (helpers included). */
export function conversationTotals(state: ConversationViewState): RunUsage {
  return state.runs.reduce<RunUsage>(
    (sum, run) => ({
      inputTokens: sum.inputTokens + run.usage.inputTokens,
      outputTokens: sum.outputTokens + run.usage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + run.usage.cachedInputTokens,
      costUsdMicros: sum.costUsdMicros + run.usage.costUsdMicros,
    }),
    { ...ZERO_USAGE, costUsdMicros: state.unloadedCostUsdMicros },
  );
}

export type ComposerMode =
  | { kind: "steer" }
  | { kind: "followUp"; recreatesCheckout: boolean }
  | {
      kind: "disabled";
      reason: "preparing" | "recreating" | "finishing" | "packageDeleted";
      /** Stop stays available while the run is live. */
      live: boolean;
    };

/**
 * What the composer offers. While the main run is live: steering, except
 * while its checkout is being prepared (re-created, when it was pruned) or
 * the final answer is being written (steering is closed then). Once it has
 * finished: a follow-up, unless the package is gone.
 */
export function composerMode(state: ConversationViewState): ComposerMode {
  const main = latestMainRun(state);
  const recreating = !state.conversation.checkoutAvailable;
  if (main && isActive(main.status)) {
    if (main.phase === "preparing") {
      return { kind: "disabled", reason: recreating ? "recreating" : "preparing", live: true };
    }
    if (main.phase === "finishing") return { kind: "disabled", reason: "finishing", live: true };
    return { kind: "steer" };
  }
  if (state.conversation.packageId === null) {
    return { kind: "disabled", reason: "packageDeleted", live: false };
  }
  return { kind: "followUp", recreatesCheckout: recreating };
}

// ── Parts ──

type PartRecord = Record<string, unknown>;

function record(part: MessagePart): PartRecord {
  return part as PartRecord;
}

function stringField(part: MessagePart, key: string): string | null {
  const value = record(part)[key];
  return typeof value === "string" ? value : null;
}

export function partText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => stringField(part, "content") ?? "")
    .join("\n\n")
    .trim();
}

/**
 * Text parts joined the way the server builds a run's answer (`join("")`,
 * trimmed), for comparing with it. `partText` is for display.
 */
function joinedText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => stringField(part, "content") ?? "")
    .join("")
    .trim();
}

export interface ToolCallView {
  id: string;
  name: string;
  /** Parsed arguments (`input`, else the `arguments` JSON), `{}` when unreadable. */
  args: Record<string, unknown>;
  /** The raw arguments text, for the expanded row. */
  argsText: string;
  /** The tool's result text, once it has one. */
  output: string | null;
  error: boolean;
  /** Still being written or executed. */
  pending: boolean;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return parseObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function stringifyOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/** Tool results by call id (`tool-result` parts, in any turn of a run). */
export function toolResultsOf(messages: ReadonlyArray<{ parts: readonly MessagePart[] }>) {
  const results = new Map<string, { content: string | null; error: boolean }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      const id = stringField(part, "toolCallId");
      if (!id) continue;
      results.set(id, {
        content: stringifyOutput(record(part).content),
        error: Boolean(record(part).error) || stringField(part, "state") === "error",
      });
    }
  }
  return results;
}

export function toolCallOf(
  part: MessagePart,
  results: ReadonlyMap<string, { content: string | null; error: boolean }>,
): ToolCallView | null {
  if (part.type !== "tool-call") return null;
  const id = stringField(part, "id") ?? "";
  const name = stringField(part, "name") ?? "";
  const argsText = stringField(part, "arguments") ?? stringifyOutput(record(part).input) ?? "";
  const args = parseObject(record(part).input) ?? parseObject(argsText) ?? {};
  const result = results.get(id);
  const output = stringifyOutput(record(part).output) ?? result?.content ?? null;
  const state = stringField(part, "state");
  return {
    id,
    name,
    args,
    argsText,
    output,
    error: result?.error === true || state === "error",
    pending: output === null && !result,
  };
}

/**
 * Whether two views of a tool call render the same row. `args` is parsed
 * from `argsText` and `error` already folds in the part's state, so these
 * fields cover everything the row shows.
 */
export function sameToolCallView(a: ToolCallView, b: ToolCallView): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.argsText === b.argsText &&
    a.output === b.output &&
    a.error === b.error &&
    a.pending === b.pending
  );
}

/**
 * Whether two helper lists hold the same runs. The list is a new slice on
 * every fold, but a run nothing touched keeps its identity (`updateRun`
 * replaces only the run an event names), so element identity is enough.
 */
export function sameRuns(
  a: readonly RunView[] | undefined,
  b: readonly RunView[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((run, index) => run === b[index]);
}

// ── Tool-call summaries ──

const UNTRUSTED_START = "<<<UNTRUSTED_WEB_CONTENT_START>>>";
const UNTRUSTED_END = "<<<UNTRUSTED_WEB_CONTENT_END>>>";
const STORED_MARKER = /\n?\[stored result id=[^\]]*\]\s*$/;

/**
 * The body of a fenced tool result (`@cockpit-context/agent-runtime`'s untrusted
 * wrapper: start marker, source line, notice line, body, end marker). Text
 * without the fence comes back unchanged.
 */
export function unwrapToolOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith(UNTRUSTED_START)) return output;
  const lines = trimmed.split("\n");
  const end = lines.lastIndexOf(UNTRUSTED_END);
  return lines.slice(3, end === -1 ? undefined : end).join("\n");
}

/**
 * A tool result as a person reads it in an expanded row: the fence removed,
 * JSON pretty-printed, and a multi-line `content` string (a `read` result's
 * numbered lines) shown as lines under the other fields instead of one
 * escaped string. Anything that is not a JSON object comes back unwrapped.
 */
export function readableToolOutput(output: string): string {
  const body = unwrapToolOutput(output);
  const stored = body.match(STORED_MARKER)?.[0] ?? "";
  const json = parseObject(body.replace(STORED_MARKER, ""));
  if (!json) return body;
  const { content, ...rest } = json;
  if (typeof content === "string" && content.includes("\n")) {
    const meta = Object.keys(rest).length > 0 ? `${JSON.stringify(rest, null, 2)}\n\n` : "";
    return `${meta}${content}${stored}`;
  }
  return `${JSON.stringify(json, null, 2)}${stored}`;
}

function outputJson(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  return parseObject(unwrapToolOutput(output).replace(STORED_MARKER, ""));
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function textArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export type ToolOutcome =
  | { kind: "matches" | "files" | "locations" | "helpers"; count: number; truncated?: boolean }
  | { kind: "error" };

export interface ToolSummary {
  /** What the call looked at: `"pattern"`, `path:120-200`, `path:12:4`, a symbol query. */
  subject: string | null;
  /** Where it looked (grep/glob `path`), rendered as "in …". */
  scope: string | null;
  outcome: ToolOutcome | null;
}

const LOCATION_LINE = /:\d+:\d+/;

function countLocations(output: string | null): number | null {
  if (!output) return null;
  return unwrapToolOutput(output)
    .split("\n")
    .filter((line) => LOCATION_LINE.test(line)).length;
}

function readRange(call: ToolCallView): string | null {
  const path = textArg(call.args, "path");
  if (!path) return null;
  const json = outputJson(call.output);
  const offset = numberField(json, "offset") ?? numberField(call.args, "offset");
  const limit = numberField(json, "limit") ?? numberField(call.args, "limit");
  const total = numberField(json, "totalLines");
  if (offset === null && limit === null) return path;
  const start = offset ?? 1;
  const last = start + (limit ?? 200) - 1;
  const end = total !== null ? Math.min(last, total) : last;
  return end >= start ? `${path}:${start}-${end}` : `${path}:${start}`;
}

function position(call: ToolCallView): string | null {
  const path = textArg(call.args, "path");
  if (!path) return null;
  const line = numberField(call.args, "line");
  const column = numberField(call.args, "column") ?? numberField(call.args, "character");
  if (line === null) return path;
  return column === null ? `${path}:${line}` : `${path}:${line}:${column}`;
}

/**
 * A one-line description of a tool call, from its arguments and (once it
 * has one) its result: `grep "pattern" in path → 12 matches`,
 * `read path:120-200`. The caller renders the words around the pieces.
 */
export function summarizeToolCall(call: ToolCallView): ToolSummary {
  const json = outputJson(call.output);
  const matches = Array.isArray(json?.matches) ? json.matches.length : null;
  const truncated = json?.truncated === true;
  const errored: ToolOutcome | null = call.error ? { kind: "error" } : null;
  switch (call.name) {
    case "grep":
    case "glob": {
      const pattern = textArg(call.args, "pattern");
      return {
        subject: pattern ? `“${pattern}”` : null,
        scope: textArg(call.args, "path"),
        outcome:
          errored ??
          (matches === null
            ? null
            : { kind: call.name === "grep" ? "matches" : "files", count: matches, truncated }),
      };
    }
    case "read":
      return { subject: readRange(call), scope: null, outcome: errored };
    case "lsp_definition":
    case "lsp_references": {
      const count = countLocations(call.output);
      return {
        subject: position(call),
        scope: null,
        outcome: errored ?? (count === null ? null : { kind: "locations", count }),
      };
    }
    case "lsp_hover":
      return { subject: position(call), scope: null, outcome: errored };
    case "lsp_document_symbols":
      return { subject: textArg(call.args, "path"), scope: null, outcome: errored };
    case "lsp_workspace_symbols": {
      const query = textArg(call.args, "query");
      const count = countLocations(call.output);
      return {
        subject: query ? `“${query}”` : null,
        scope: null,
        outcome: errored ?? (count === null ? null : { kind: "locations", count }),
      };
    }
    case "delegate_explore": {
      const agents = Array.isArray(call.args.agents) ? call.args.agents.length : null;
      return {
        subject: null,
        scope: null,
        outcome: errored ?? (agents === null ? null : { kind: "helpers", count: agents }),
      };
    }
    default:
      return { subject: null, scope: null, outcome: errored };
  }
}

// ── Transcript ──

export type TranscriptBlock =
  | { kind: "question"; key: string; text: string; followUp: boolean }
  | { kind: "steer"; key: string; text: string }
  | {
      kind: "assistant";
      key: string;
      runId: string;
      parts: MessagePart[];
      results: Map<string, { content: string | null; error: boolean }>;
      /** Helper runs started by each `delegate_explore` call, by call id. */
      helpers: Map<string, RunView[]>;
      streaming: boolean;
      /** The completed run's closing message: its answer. */
      final: boolean;
    }
  | { kind: "helpers"; key: string; runs: RunView[] }
  | { kind: "working"; key: string; run: RunView }
  | { kind: "answer"; key: string; text: string }
  | { kind: "ended"; key: string; run: RunView };

function delegateCalls(messages: ReadonlyArray<{ parts: readonly MessagePart[] }>) {
  const calls: Array<{ id: string; count: number | null }> = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call" || stringField(part, "name") !== "delegate_explore") continue;
      const args =
        parseObject(record(part).input) ?? parseObject(stringField(part, "arguments")) ?? {};
      calls.push({
        id: stringField(part, "id") ?? "",
        count: Array.isArray(args.agents) ? args.agents.length : null,
      });
    }
  }
  return calls;
}

/**
 * Pair a run's helpers with the `delegate_explore` calls that started them.
 * Helper indexes are unique across the run's calls and handed out in call
 * order, so helpers sorted by index (else creation order) fill each call's
 * `agents` count in turn. Helpers no call claims are returned separately.
 */
export function assignHelpers(
  messages: ReadonlyArray<{ parts: readonly MessagePart[] }>,
  helpers: readonly RunView[],
): { byCall: Map<string, RunView[]>; unassigned: RunView[] } {
  const ordered = helpers
    .map((run, order) => ({ run, order }))
    .sort(
      (a, b) =>
        (a.run.helperIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.run.helperIndex ?? Number.MAX_SAFE_INTEGER) || a.order - b.order,
    )
    .map((entry) => entry.run);
  const byCall = new Map<string, RunView[]>();
  const calls = delegateCalls(messages);
  let next = 0;
  calls.forEach((call, index) => {
    const last = index === calls.length - 1;
    const take = call.count === null || last ? ordered.length - next : call.count;
    byCall.set(call.id, ordered.slice(next, next + take));
    next += take;
  });
  return { byCall, unassigned: ordered.slice(next) };
}

/** The last assistant turn with text and no tool calls: a completed run's answer. */
function finalAnswerSeq(turns: readonly TurnItem[]): number | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role !== "assistant") continue;
    if (turn.parts.some((part) => part.type === "tool-call")) return null;
    return partText(turn.parts) ? turn.seq : null;
  }
  return null;
}

function isMentionedAnswer(turns: readonly TurnItem[], answer: string): boolean {
  const target = answer.trim();
  return turns.some((turn) => turn.role === "assistant" && joinedText(turn.parts) === target);
}

/**
 * The main transcript: each main run's question (or follow-up), its steering
 * turns, the assistant's messages with their tool calls (helpers nested
 * under the `delegate_explore` call that started them), the streaming
 * message, and a closing note for a run that did not complete.
 *
 * Assistant blocks are keyed by their ordinal among the run's assistant
 * messages, not by `seq`: the streaming message is always the newest one,
 * so the saved turn that replaces it inherits its key and keeps the
 * reader's expanded rows and panels open.
 */
export function buildTranscript(state: ConversationViewState): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const helpersOf = new Map<string, RunView[]>();
  for (const run of state.runs) {
    if (run.kind !== "helper" || !run.parentRunId) continue;
    const list = helpersOf.get(run.parentRunId) ?? [];
    list.push(run);
    helpersOf.set(run.parentRunId, list);
  }

  mainRuns(state).forEach((run, runIndex) => {
    const messages: Array<{ parts: readonly MessagePart[] }> = [...run.turns];
    if (run.partial) messages.push(run.partial);
    const results = toolResultsOf(messages);
    const { byCall, unassigned } = assignHelpers(messages, helpersOf.get(run.id) ?? []);
    const finalSeq = run.status === "completed" ? finalAnswerSeq(run.turns) : null;
    let sawQuestion = false;
    let assistantOrdinal = 0;

    for (const turn of run.turns) {
      if (turn.role === "user") {
        const key = `${run.id}:${turn.seq}`;
        const text = partText(turn.parts);
        if (!text) continue;
        if (turn.steering) blocks.push({ kind: "steer", key, text });
        else if (!sawQuestion) {
          sawQuestion = true;
          blocks.push({ kind: "question", key, text, followUp: runIndex > 0 });
        } else blocks.push({ kind: "steer", key, text });
        continue;
      }
      if (turn.role !== "assistant") continue;
      blocks.push({
        kind: "assistant",
        key: `${run.id}:a${assistantOrdinal++}`,
        runId: run.id,
        parts: turn.parts,
        results,
        helpers: byCall,
        streaming: false,
        final: turn.seq === finalSeq,
      });
    }

    if (run.partial) {
      blocks.push({
        kind: "assistant",
        key: `${run.id}:a${assistantOrdinal}`,
        runId: run.id,
        parts: run.partial.parts,
        results,
        helpers: byCall,
        streaming: isActive(run.status),
        final: false,
      });
    }
    if (unassigned.length > 0) {
      blocks.push({ kind: "helpers", key: `${run.id}:helpers`, runs: unassigned });
    }
    if (run.status === "completed" && run.answer && !isMentionedAnswer(run.turns, run.answer)) {
      blocks.push({ kind: "answer", key: `${run.id}:answer`, text: run.answer });
    }
    if (isActive(run.status)) {
      // Between two messages (tools running, queued, preparing): say so.
      if (!run.partial) blocks.push({ kind: "working", key: `${run.id}:working`, run });
    } else if (run.status !== "completed") {
      blocks.push({ kind: "ended", key: `${run.id}:ended`, run });
    }
  });
  return blocks;
}

/**
 * A cheap "something new is on screen" signal for auto-scroll: counts and
 * lengths only, never the text itself.
 */
export function transcriptActivityKey(state: ConversationViewState | null): string {
  if (!state) return "";
  return state.runs
    .map((run) => {
      let size = 0;
      for (const part of run.partial?.parts ?? []) {
        for (const value of Object.values(record(part))) {
          if (typeof value === "string") size += value.length;
        }
      }
      return `${run.id}:${run.status}:${run.turns.length}:${run.partial?.parts.length ?? 0}:${size}`;
    })
    .join("|");
}

// ── Display helpers ──

/** The version a conversation reads: the resolved tag/branch/commit, else what was asked for. */
export function conversationVersion(item: {
  resolvedFrom: string | null;
  commitSha: string | null;
  requestedVersion: string | null;
  requestedRef: string | null;
}): string | null {
  if (item.commitSha) return describeResolvedFrom(item.resolvedFrom, item.commitSha).label;
  return item.requestedVersion ?? item.requestedRef;
}

/**
 * Number formatters are costly to build and these run per row per second (the
 * live list ticks) and per watch event, so each locale + variant is built once.
 */
const NUMBER_FORMATTERS = new Map<string, Intl.NumberFormat>();

type NumberFormatVariant = "usd2" | "usd4" | "tokens";

const NUMBER_FORMAT_OPTIONS: Record<NumberFormatVariant, Intl.NumberFormatOptions> = {
  usd2: { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 },
  usd4: { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 },
  tokens: { notation: "compact", maximumFractionDigits: 1 },
};

function numberFormatter(locale: string, variant: NumberFormatVariant): Intl.NumberFormat {
  const key = `${locale}\u0000${variant}`;
  let formatter = NUMBER_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, NUMBER_FORMAT_OPTIONS[variant]);
    NUMBER_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/** `1234` micro-dollars → `$0.0012`: four decimals below a dollar, two above. */
export function formatUsdMicros(micros: number, locale: string): string {
  const usd = Math.max(0, micros) / 1_000_000;
  return numberFormatter(locale, usd > 0 && usd < 1 ? "usd4" : "usd2").format(usd);
}

/** `12345` → `12K` (compact, in the active locale). */
export function formatTokens(count: number, locale: string): string {
  return numberFormatter(locale, "tokens").format(Math.max(0, count));
}

/** Milliseconds → `0:42`, `12:05`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Stop reasons with their own copy (`dashboard:conversation.stopReasons.*`). */
const KNOWN_STOP_REASONS = [
  "max-iterations",
  "output-truncated",
  "timeout",
  "aborted",
  "vetoed",
  "checkout-failed",
  "package-deleted",
  "model-error",
  "engine-error",
  "interrupted",
] as const;

export type KnownStopReason = (typeof KNOWN_STOP_REASONS)[number];

export function isKnownStopReason(reason: string | null): reason is KnownStopReason {
  return KNOWN_STOP_REASONS.some((known) => known === reason);
}

/** Merge list pages into one id-unique list (a conversation can move between segments). */
export function dedupeConversations<Item extends { id: string }>(
  pages: ReadonlyArray<{ items: Item[] }> | undefined,
): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}
