import { randomUUID } from "node:crypto";
import {
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentMessage,
  type AgentModel,
  type AgentStopReason,
  type AgentTool,
  type AgentUsage,
  defineTool,
  type ModelApi,
  type ResultStore,
  runAgentLoop,
  wrapUntrustedContent,
} from "@cockpit-context/agent-runtime";
import { z } from "zod";
import { formatPerCallRange, type HelperLimits, resolveHelperLimits } from "./helper-limits";
import type { LspManager } from "./lsp/manager";
import { buildLspTools } from "./lsp/tools";
import {
  buildExploreSystemPrompt,
  DELEGATE_EXPLORE_TOOL_NAME,
  type ExplorePackageInfo,
  FORCE_FINAL_SYSTEM_NOTE,
  FORCE_FINAL_USER_PROMPT,
  type OverviewSource,
} from "./prompts";
import { generateRepoMap, type RepoMap } from "./repo-map";
import type { RipgrepSetting } from "./ripgrep";
import { buildExploreTools, wrapUntrustedToolResult } from "./tools";
import { sumUsage, UsageMeter, ZERO_USAGE } from "./usage";

// ---------------------------------------------------------------------------
// Budgets. The package never reads env: the run engine maps COCKPIT_CONTEXT_MAX_ITERATIONS
// and COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS onto these options. The defaults equal the env
// defaults so a caller that passes nothing gets the documented behavior.
// ---------------------------------------------------------------------------

/** Master dispatch budget (COCKPIT_CONTEXT_MAX_ITERATIONS default). */
export const DEFAULT_MAX_ITERATIONS = 100;
/** Master wall-clock budget (COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS default, in ms). */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/** Inline budget for the combined helper reports the master reads. */
const DELEGATE_MAX_RESULT_CHARS = 24_000;
/** Room kept for the budget notes ahead of the fenced reports. */
const DELEGATE_NOTES_CHARS = 500;
const DELEGATE_SOURCE = "helpers:delegate_explore";
/** The fenced reports' own budget: the result minus the notes and the fence. */
const DELEGATE_REPORTS_CHARS =
  DELEGATE_MAX_RESULT_CHARS -
  DELEGATE_NOTES_CHARS -
  wrapUntrustedContent("", { sourceUrl: DELEGATE_SOURCE }).length;
/** Longest focus or error shown in a report heading (both can be long). */
const MAX_HEADING_FIELD_CHARS = 160;
const REPORT_TRUNCATED = "\n…[report truncated]";
/** Id of the synthetic user message that opens the force-final synthesis turn. */
export const FORCE_FINAL_MESSAGE_ID = "explore-force-final";

export type ExploreBudgets = {
  maxIterations: number;
  timeoutMs: number;
  helperMaxIterations: number;
  helperTimeoutMs: number;
  synthesisTimeoutMs: number;
  summaryMaxIterations: number;
  summaryTimeoutMs: number;
};

/**
 * Derive the helper, synthesis and summary budgets from the master's.
 *
 * The ratios set the helper, synthesis and summary budgets at the env defaults
 * (100 iterations / 600 s): helpers get 6 iterations and 90 s, the force-final
 * synthesis 90 s, and the checkout summary 30 iterations and 300 s. Every
 * derived value can still be overridden per call.
 */
export function deriveExploreBudgets(
  base: { maxIterations?: number; timeoutMs?: number } = {},
): ExploreBudgets {
  const maxIterations = base.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = base.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  return {
    maxIterations,
    timeoutMs,
    helperMaxIterations: Math.min(maxIterations, Math.max(2, Math.round(maxIterations * 0.06))),
    helperTimeoutMs: Math.max(10_000, Math.round(timeoutMs * 0.15)),
    synthesisTimeoutMs: Math.min(timeoutMs, 90_000),
    summaryMaxIterations: Math.min(maxIterations, Math.max(5, Math.round(maxIterations * 0.3))),
    summaryTimeoutMs: Math.max(10_000, Math.round(timeoutMs * 0.5)),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExploreTurn = Parameters<NonNullable<AgentLoopOptions["onTurn"]>>[0];
type TurnHook = (turn: ExploreTurn) => void | Promise<void>;
type MessagesHook = (messages: AgentMessage[]) => void | Promise<void>;
type UsageHook = (usage: AgentUsage) => void;

/** What a helper was asked to do, handed to `onHelperStart`. */
export type ExploreHelperStart = {
  /** 0-based, unique across every `delegate_explore` call in the run. */
  index: number;
  focus: string;
  question: string;
};

/** What `onHelperStart` may hand back: the child run id and the helper's own hooks. */
export type ExploreHelperHooks = {
  helperRunId?: string;
  onTurn?: TurnHook;
  onMessagesChange?: MessagesHook;
  /** Per-dispatch usage of this helper (live cost). */
  onUsage?: UsageHook;
};

/** One finished helper run, reported through `onHelperFinish` and on the result. */
export type ExploreHelperRun = ExploreHelperStart & {
  helperRunId?: string;
  model: string;
  /** Absent only when the helper failed before its loop returned (`error` is set). */
  stopReason?: AgentStopReason;
  forcedFinal: boolean;
  answer: string;
  usage: AgentUsage;
  iterations: number;
  error?: string;
};

export type ExploreAgentOptions = {
  /** Absolute path to the dependency checkout. */
  root: string;
  /** The investigation question (or the follow-up message). */
  question: string;
  /** Earlier turns of the conversation, for a follow-up run. */
  history?: AgentMessage[];
  /** Package under investigation (system prompt section 3). */
  package?: ExplorePackageInfo;
  /** The owner's notes about the package (section 4). */
  userNotes?: string;
  /** The checkout's overview (section 5): the owner's edit, else the model-written one. */
  overview?: string;
  /** Who wrote `overview` (section header label). Default `model`. */
  overviewSource?: OverviewSource;
  /**
   * Inject a precomputed repo map (the checkout's stored one), generate one when
   * `true` / omitted, or skip it when `false`.
   */
  repoMap?: RepoMap | boolean;
  /** Prefer examples/docs before deep src exploration. Default true. */
  examplesFirst?: boolean;

  apiKey: string;
  /** OpenRouter model id for the master (COCKPIT_CONTEXT_MODEL). There is no default. */
  model: string;
  /** Model for helpers (COCKPIT_CONTEXT_HELPER_MODEL); defaults to `model`. */
  helperModel?: string;
  /** API the agent speaks to the model endpoint (COCKPIT_CONTEXT_MODEL_API). Default `chat-completions`. */
  api?: ModelApi;
  /** API root override, ending in `/v1` (COCKPIT_CONTEXT_OPENROUTER_BASE_URL). Default OpenRouter. */
  baseUrl?: string;
  /** COCKPIT_CONTEXT_MODEL_STALL_SECONDS in ms (see `AgentModel.stallTimeoutMs`). */
  stallTimeoutMs?: number;

  maxIterations?: number;
  timeoutMs?: number;
  helperMaxIterations?: number;
  helperTimeoutMs?: number;
  synthesisTimeoutMs?: number;
  abortSignal?: AbortSignal;

  /** When the loop stops on max-iterations/timeout, run a no-tool synthesis turn. Default true. */
  forceFinalAnswer?: boolean;
  /** Register `delegate_explore` (master mode). Default true. */
  allowDelegation?: boolean;
  /**
   * Helpers running at once across the run (COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS).
   * Default 5, clamped to `maxHelpers`. The limit is run-wide: TanStack AI
   * executes one turn's tool calls in parallel, so a turn with two
   * `delegate_explore` calls shares these slots rather than doubling them.
   * One call may pass at most this many briefs.
   */
  maxParallelHelpers?: number;
  /**
   * Helpers the run may start across all its `delegate_explore` calls
   * (COCKPIT_CONTEXT_MAX_HELPERS). Default 10. A call past it fails; a call
   * asking for more than what is left runs the first briefs that fit.
   */
  maxHelpers?: number;

  /**
   * LSP tools for this checkout (`buildLspTools`): the master and every helper
   * get `lsp_*` for the languages the checkout has, served by the process-wide
   * `manager`. Omitted, or a disabled manager (`COCKPIT_CONTEXT_LSP_MAX_SERVERS=0`): none.
   */
  lsp?: { manager: LspManager; checkoutId: string };
  /**
   * Extra tools for the master and every helper. Mark anything that returns
   * checkout content `untrusted: true`.
   */
  extraTools?: readonly AgentTool[];
  /** grep backend (`"auto"`: ripgrep from PATH, else JavaScript). */
  ripgrep?: RipgrepSetting;
  resultStore?: ResultStore;
  /** Prefix-cache key; helpers share `${cacheKey}:helper`. */
  cacheKey?: string;

  /**
   * Steering seam: called by the agent loop right before each master dispatch;
   * the returned user messages are appended to the conversation. Master only —
   * helpers are never steered, and the force-final synthesis does not take it.
   * Forwarded to `runAgentLoop` as `takeSteeringMessages` (see its contract).
   */
  takeSteeringMessages?: () => AgentMessage[];

  /** Every master turn in append order (seeds first, synthesis included, no repeats). */
  onTurn?: TurnHook;
  /** The master's rebuilt message array, live (streaming assistant text). */
  onMessagesChange?: MessagesHook;
  /** Per-dispatch usage of the master loop and its synthesis (live cost; helpers excluded). */
  onUsage?: UsageHook;
  /** The master loop stopped and the no-tool synthesis turn is starting. */
  onSynthesisStart?: () => void | Promise<void>;
  /** A helper is about to start; may return its child run id and hooks. */
  onHelperStart?: (
    helper: ExploreHelperStart,
  ) => ExploreHelperHooks | undefined | Promise<ExploreHelperHooks | undefined>;
  /** A helper finished (any outcome, including failure). */
  onHelperFinish?: (run: ExploreHelperRun) => void | Promise<void>;
};

export type ExploreAgentResult = AgentLoopResult & {
  /** The final assistant text. */
  answer: string;
  /** Total usage: master + helpers + force-final synthesis. */
  usage: AgentUsage;
  /** The master's own usage (master loop + synthesis), excluding helpers. */
  ownUsage: AgentUsage;
  /** Completed master dispatches (synthesis included). */
  iterations: number;
  model: string;
  map?: RepoMap;
  forcedFinal: boolean;
  /** Set when the synthesis turn itself failed; the master's result stands. */
  synthesisError?: string;
  /** `delegate_explore` calls that started helpers (a call refused by the helper limit is not counted). */
  delegateCalls: number;
  helperRuns: ExploreHelperRun[];
};

/**
 * The master loop failed (model error that survived retry and failover, or a
 * `FatalToolError`). Carries what was already spent so the run engine can still
 * account for it; the original error is `cause`.
 */
export class ExploreAgentError extends Error {
  readonly usage: AgentUsage;
  readonly helperRuns: ExploreHelperRun[];

  constructor(
    message: string,
    options: { cause: unknown; usage: AgentUsage; helperRuns: ExploreHelperRun[] },
  ) {
    super(message, { cause: options.cause });
    this.name = "ExploreAgentError";
    this.usage = options.usage;
    this.helperRuns = options.helperRuns;
  }
}

// ---------------------------------------------------------------------------
// One investigation loop (master or helper) + its force-final synthesis
// ---------------------------------------------------------------------------

type InvestigationParams = {
  model: AgentModel;
  tools: AgentTool[];
  systemPrompt: string;
  synthesisPrompt: string;
  messages: AgentMessage[];
  maxIterations: number;
  timeoutMs: number;
  deadlineAt?: number;
  synthesisTimeoutMs: number;
  abortSignal?: AbortSignal;
  forceFinalAnswer: boolean;
  resultStore?: ResultStore;
  cacheKey?: string;
  takeSteeringMessages?: () => AgentMessage[];
  onTurn?: TurnHook;
  onMessagesChange?: MessagesHook;
  onUsage?: UsageHook;
  onSynthesisStart?: () => void | Promise<void>;
};

type InvestigationOutcome = {
  result: AgentLoopResult;
  usage: AgentUsage;
  iterations: number;
  forcedFinal: boolean;
  synthesisError?: string;
};

class InvestigationFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly usage: AgentUsage,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Relays a loop's turns to the caller with one running `seq` across the
 * master loop and the synthesis loop, and keeps the completed turns as a
 * transcript. A loop cut off by a deadline abort returns only its seeds, but
 * every dispatch that completed was announced here first (with its tool
 * results), so the synthesis turn still sees the investigation.
 */
class TurnRelay {
  readonly collected: AgentMessage[] = [];
  private seq = 0;
  private skip = 0;

  constructor(private readonly onTurn?: TurnHook) {}

  /** Swallow the next `count` announcements (seeds already relayed). */
  skipNext(count: number): void {
    this.skip = count;
  }

  readonly hook = async (turn: ExploreTurn): Promise<void> => {
    if (this.skip > 0) {
      this.skip -= 1;
      return;
    }
    this.collected.push(turn.message);
    const seq = this.seq;
    this.seq += 1;
    await this.onTurn?.({ ...turn, seq });
  };

  /** The longer of the loop's returned messages and the relayed transcript. */
  transcript(result: AgentLoopResult): AgentMessage[] {
    return this.collected.length > result.messages.length ? [...this.collected] : result.messages;
  }
}

async function runInvestigation(params: InvestigationParams): Promise<InvestigationOutcome> {
  const relay = new TurnRelay(params.onTurn);
  const meter = new UsageMeter(params.onUsage);

  const loopOptions: AgentLoopOptions = {
    model: params.model,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    maxIterations: params.maxIterations,
    timeoutMs: params.timeoutMs,
    deadlineAt: params.deadlineAt,
    abortSignal: params.abortSignal,
    resultStore: params.resultStore,
    cacheKey: params.cacheKey,
    onTurn: relay.hook,
    onMessagesChange: params.onMessagesChange,
    onUsage: meter.onUsage,
    ...(params.takeSteeringMessages ? { takeSteeringMessages: params.takeSteeringMessages } : {}),
  };

  let loopResult: AgentLoopResult;
  try {
    loopResult = await runAgentLoop(loopOptions);
  } catch (error) {
    throw new InvestigationFailure(error, meter.settle());
  }
  const loopUsage = meter.settle(loopResult.usage);
  const transcript = relay.transcript(loopResult);
  const result: AgentLoopResult = { ...loopResult, messages: transcript, usage: loopUsage };

  const needsSynthesis =
    params.forceFinalAnswer &&
    (loopResult.stopReason === "max-iterations" || loopResult.stopReason === "timeout");
  if (!needsSynthesis) {
    return { result, usage: loopUsage, iterations: meter.iterations, forcedFinal: false };
  }

  try {
    await params.onSynthesisStart?.();
  } catch (error) {
    console.warn("[explore] onSynthesisStart hook failed", error);
  }

  const synthesisMeter = new UsageMeter(params.onUsage);
  const forceFinal: AgentMessage = {
    id: FORCE_FINAL_MESSAGE_ID,
    role: "user",
    parts: [{ type: "text", content: FORCE_FINAL_USER_PROMPT }],
  };
  // The synthesis loop re-announces its seeds; the transcript part was relayed already.
  relay.skipNext(transcript.length);
  try {
    const synthesis = await runAgentLoop({
      model: params.model,
      systemPrompt: params.synthesisPrompt,
      messages: [...transcript, forceFinal],
      tools: [],
      maxIterations: 1,
      timeoutMs: params.synthesisTimeoutMs,
      abortSignal: params.abortSignal,
      onTurn: relay.hook,
      onMessagesChange: params.onMessagesChange,
      onUsage: synthesisMeter.onUsage,
    });
    const usage = sumUsage(loopUsage, synthesisMeter.settle(synthesis.usage));
    return {
      result: {
        ...synthesis,
        // Report why the investigation stopped, not the synthesis turn's clean finish.
        stopReason: loopResult.stopReason,
        messages: synthesis.messages,
        usage,
      },
      usage,
      iterations: meter.iterations + synthesisMeter.iterations,
      forcedFinal: true,
    };
  } catch (error) {
    const usage = sumUsage(loopUsage, synthesisMeter.settle());
    return {
      result: { ...result, usage },
      usage,
      iterations: meter.iterations + synthesisMeter.iterations,
      forcedFinal: false,
      synthesisError: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Master run
// ---------------------------------------------------------------------------

type RunState = {
  helperRuns: ExploreHelperRun[];
  pending: Set<Promise<unknown>>;
  delegateCalls: number;
  /** Helpers granted so far (reserved when a call starts, counted against `maxHelpers`). */
  helpersGranted: number;
  nextHelperIndex: number;
  /** Run-wide helper slots, shared by every `delegate_explore` call. */
  helperSlots: <T>(fn: () => Promise<T>) => Promise<T>;
};

/**
 * One investigation against a confined checkout: the master agent with
 * mid-flight `delegate_explore`, the repo map and examples-first prompt, and a
 * force-final synthesis when the budget runs out.
 */
export async function runExploreAgent(options: ExploreAgentOptions): Promise<ExploreAgentResult> {
  const examplesFirst = options.examplesFirst ?? true;
  const forceFinalAnswer = options.forceFinalAnswer ?? true;
  const allowDelegation = options.allowDelegation ?? true;
  const budgets = deriveExploreBudgets(options);
  const helperMaxIterations = options.helperMaxIterations ?? budgets.helperMaxIterations;
  const helperTimeoutMs = options.helperTimeoutMs ?? budgets.helperTimeoutMs;
  const synthesisTimeoutMs = options.synthesisTimeoutMs ?? budgets.synthesisTimeoutMs;
  const deadlineAt = Date.now() + budgets.timeoutMs;
  const helperLimits = resolveHelperLimits(options);

  const map = await resolveMap(options);
  const baseTools: AgentTool[] = [
    ...buildExploreTools(options.root, { ripgrep: options.ripgrep }),
    ...(options.lsp
      ? buildLspTools({
          ...options.lsp,
          root: options.root,
          subdirectory: options.package?.subdirectory,
        })
      : []),
    ...(options.extraTools ?? []),
  ];
  const state: RunState = {
    helperRuns: [],
    pending: new Set(),
    delegateCalls: 0,
    helpersGranted: 0,
    nextHelperIndex: 0,
    helperSlots: createLimiter(helperLimits.maxParallel),
  };

  const promptContext = {
    package: options.package,
    userNotes: options.userNotes,
    overview: options.overview,
    overviewSource: options.overviewSource,
    repoMap: map,
  };
  const helperModel: AgentModel = modelFor(options, options.helperModel ?? options.model);
  const helperSystemPrompt = buildExploreSystemPrompt({
    ...promptContext,
    tools: baseTools,
    examplesFirst: true,
  });
  const helperSynthesisPrompt = buildExploreSystemPrompt({
    ...promptContext,
    tools: baseTools,
    trailer: FORCE_FINAL_SYSTEM_NOTE,
  });

  const runHelper = async (
    brief: { focus: string; question: string },
    signal: AbortSignal,
  ): Promise<ExploreHelperRun> => {
    const start: ExploreHelperStart = { index: state.nextHelperIndex++, ...brief };
    // Queued for a slot past an abort or the master's deadline: never start it
    // (no onHelperStart, so the caller records no helper run that never ran).
    if (signal.aborted) {
      return {
        ...start,
        model: helperModel.model,
        forcedFinal: false,
        answer: "",
        usage: ZERO_USAGE,
        iterations: 0,
        error: "Helper not started: the investigation was aborted.",
      };
    }
    let hooks: ExploreHelperHooks | undefined;
    try {
      hooks = (await options.onHelperStart?.(start)) ?? undefined;
    } catch (error) {
      console.warn("[explore] onHelperStart hook failed", error);
    }
    const base = { ...start, helperRunId: hooks?.helperRunId, model: helperModel.model };
    let run: ExploreHelperRun;
    try {
      const outcome = await runInvestigation({
        model: helperModel,
        tools: baseTools,
        systemPrompt: helperSystemPrompt,
        synthesisPrompt: helperSynthesisPrompt,
        messages: [
          {
            id: `explore-helper-${start.index}-user`,
            role: "user",
            parts: [
              {
                type: "text",
                content: `Focus: ${brief.focus}\n\n${brief.question}\n\nReturn bullet findings with file:line. No long tutorial.`,
              },
            ],
          },
        ],
        maxIterations: helperMaxIterations,
        timeoutMs: helperTimeoutMs,
        // Never outlive the master's own deadline.
        deadlineAt,
        synthesisTimeoutMs: Math.min(synthesisTimeoutMs, helperTimeoutMs),
        // The tool's signal fires on the master's deadline or cancel.
        abortSignal: signal,
        forceFinalAnswer: true,
        resultStore: options.resultStore,
        cacheKey: options.cacheKey ? `${options.cacheKey}:helper` : undefined,
        onTurn: hooks?.onTurn,
        onMessagesChange: hooks?.onMessagesChange,
        onUsage: hooks?.onUsage,
      });
      run = {
        ...base,
        stopReason: outcome.result.stopReason,
        forcedFinal: outcome.forcedFinal,
        answer: exploreAgentAnswer(outcome.result),
        usage: outcome.usage,
        iterations: outcome.iterations,
        ...(outcome.synthesisError ? { error: outcome.synthesisError } : {}),
      };
    } catch (error) {
      const failure = error instanceof InvestigationFailure ? error : undefined;
      run = {
        ...base,
        forcedFinal: false,
        answer: "",
        usage: failure?.usage ?? ZERO_USAGE,
        iterations: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    state.helperRuns.push(run);
    try {
      await options.onHelperFinish?.(run);
    } catch (error) {
      console.warn("[explore] onHelperFinish hook failed", error);
    }
    return run;
  };

  const tools: AgentTool[] = [...baseTools];
  if (allowDelegation) {
    tools.push(
      buildDelegateExploreTool({
        limits: helperLimits,
        // Synchronous, before any await: two calls in one turn never both
        // take the same remaining helpers.
        grant: (requested) => {
          const granted = Math.min(requested, helperLimits.maxHelpers - state.helpersGranted);
          if (granted <= 0) return 0;
          state.helpersGranted += granted;
          state.delegateCalls += 1;
          return granted;
        },
        remaining: () => helperLimits.maxHelpers - state.helpersGranted,
        runHelper: (brief, signal) => {
          const promise = state.helperSlots(() => runHelper(brief, signal));
          state.pending.add(promise);
          void promise.finally(() => state.pending.delete(promise));
          return promise;
        },
      }),
    );
  }

  const systemPrompt = buildExploreSystemPrompt({
    ...promptContext,
    tools,
    examplesFirst,
    helperLimits,
  });
  const synthesisPrompt = buildExploreSystemPrompt({
    ...promptContext,
    // The transcript holds output from every tool, so keep the untrusted rules.
    tools: baseTools,
    trailer: FORCE_FINAL_SYSTEM_NOTE,
  });

  // Unique, never derived from the history: agent-runtime dedupes turn
  // announcements by message id, so a colliding id would never be announced.
  // The answer is read from after it, never from the history.
  const questionId = `explore-user-${randomUUID()}`;
  const messages: AgentMessage[] = [
    ...(options.history ?? []),
    {
      id: questionId,
      role: "user",
      parts: [{ type: "text", content: options.question.trim() }],
    },
  ];

  const model = modelFor(options, options.model);
  // A helper abandoned by the master's deadline is still aborting; wait so its
  // usage is counted.
  const settleHelpers = () => Promise.allSettled([...state.pending]);
  const helperUsage = () =>
    state.helperRuns.reduce<AgentUsage>((acc, run) => sumUsage(acc, run.usage), ZERO_USAGE);

  let outcome: InvestigationOutcome;
  try {
    outcome = await runInvestigation({
      model,
      tools,
      systemPrompt,
      synthesisPrompt,
      messages,
      maxIterations: budgets.maxIterations,
      timeoutMs: budgets.timeoutMs,
      synthesisTimeoutMs,
      abortSignal: options.abortSignal,
      forceFinalAnswer,
      resultStore: options.resultStore,
      cacheKey: options.cacheKey,
      takeSteeringMessages: options.takeSteeringMessages,
      onTurn: options.onTurn,
      onMessagesChange: options.onMessagesChange,
      onUsage: options.onUsage,
      onSynthesisStart: options.onSynthesisStart,
    });
  } catch (error) {
    await settleHelpers();
    const own = error instanceof InvestigationFailure ? error.usage : ZERO_USAGE;
    const cause = error instanceof InvestigationFailure ? error.cause : error;
    throw new ExploreAgentError(cause instanceof Error ? cause.message : String(cause), {
      cause,
      usage: sumUsage(own, helperUsage()),
      helperRuns: state.helperRuns,
    });
  }

  await settleHelpers();
  return {
    ...outcome.result,
    answer: exploreAgentAnswer(outcome.result, questionId),
    usage: sumUsage(outcome.usage, helperUsage()),
    ownUsage: outcome.usage,
    iterations: outcome.iterations,
    model: model.model,
    map,
    forcedFinal: outcome.forcedFinal,
    ...(outcome.synthesisError ? { synthesisError: outcome.synthesisError } : {}),
    delegateCalls: state.delegateCalls,
    helperRuns: state.helperRuns,
  };
}

function modelFor(options: ExploreAgentOptions, model: string): AgentModel {
  return {
    api: options.api ?? "chat-completions",
    model,
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.stallTimeoutMs !== undefined ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
  };
}

async function resolveMap(options: {
  root: string;
  repoMap?: RepoMap | boolean;
}): Promise<RepoMap | undefined> {
  if (options.repoMap === false) return undefined;
  if (options.repoMap === true || options.repoMap === undefined) {
    return generateRepoMap(options.root);
  }
  return options.repoMap;
}

// ---------------------------------------------------------------------------
// delegate_explore
// ---------------------------------------------------------------------------

/** A FIFO semaphore: at most `limit` of the wrapped calls run at once. */
function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter, or free it.
    if (next) next();
    else active -= 1;
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const clipField = (text: string) =>
  text.length > MAX_HEADING_FIELD_CHARS ? `${text.slice(0, MAX_HEADING_FIELD_CHARS)}…` : text;

/**
 * Every helper's heading and report within `maxChars`: the headings and
 * separators are counted first, and the reports share what is left equally,
 * so no helper's report is cut off by the ones before it.
 */
function formatHelperReports(runs: readonly ExploreHelperRun[], maxChars: number): string {
  const separator = "\n\n";
  const headings = runs.map((run, position) => {
    const status = run.error ? `failed: ${clipField(run.error)}` : (run.stopReason ?? "unknown");
    return `## Helper ${position + 1} — focus: ${clipField(run.focus)} (${status})\n`;
  });
  const fixed =
    headings.reduce((sum, heading) => sum + heading.length, 0) +
    separator.length * Math.max(0, runs.length - 1);
  const share = Math.max(0, Math.floor((maxChars - fixed) / Math.max(1, runs.length)));
  return runs
    .map((run, position) => {
      const report = run.answer || "(empty)";
      const clipped =
        report.length > share
          ? `${report.slice(0, Math.max(0, share - REPORT_TRUNCATED.length))}${REPORT_TRUNCATED}`
          : report;
      return `${headings[position]}${clipped}`;
    })
    .join(separator);
}

/**
 * `delegate_explore`: run `minPerCall`–`maxPerCall` read-only helper agents
 * (at most `maxParallel` at once across the run — `runHelper` takes a run-wide
 * slot), each with the confined tools and no further delegation, and return
 * their reports. The run may start `maxHelpers` helpers in total: a call
 * asking for more than what is left runs the first briefs that fit and names
 * the rest as not run; a call with nothing left fails. The reports are
 * model-written from untrusted checkout content, so they are fenced as
 * untrusted too; the budget note before them is ours.
 */
function buildDelegateExploreTool(options: {
  limits: HelperLimits;
  /** Reserve up to `requested` helpers; returns how many were granted (0 = none left). */
  grant: (requested: number) => number;
  remaining: () => number;
  runHelper: (
    brief: { focus: string; question: string },
    signal: AbortSignal,
  ) => Promise<ExploreHelperRun>;
}): AgentTool {
  const { limits } = options;
  const total = `${limits.maxHelpers} per investigation`;
  return defineTool({
    name: DELEGATE_EXPLORE_TOOL_NAME,
    description: `Run ${formatPerCallRange(limits)} read-only helper explore agents in parallel on different focuses (at most ${limits.maxParallel} run at once), then return their reports. The investigation may start at most ${limits.maxHelpers} helpers in total across all calls. Use only when fan-out across distant subtrees would help. Helpers cannot delegate.`,
    inputSchema: z.object({
      agents: z
        .array(
          z.object({
            focus: z
              .string()
              .min(1)
              .describe("Subtree or concern, e.g. docs/01-app or packages/next"),
            question: z.string().min(1).describe("Self-contained brief for that helper"),
          }),
        )
        .min(limits.minPerCall)
        .max(limits.maxPerCall),
    }),
    maxResultChars: DELEGATE_MAX_RESULT_CHARS,
    untrusted: true,
    execute: async ({ agents }, signal) => {
      const granted = options.grant(agents.length);
      if (granted === 0) {
        throw new Error(
          `Helper limit reached (${total}, all used); continue with glob, grep and read.`,
        );
      }
      const skipped = agents.slice(granted);
      const runs = await Promise.all(
        agents.slice(0, granted).map((agent) => options.runHelper(agent, signal)),
      );
      const notes = [
        skipped.length > 0
          ? `Helper limit reached (${total}): briefs ${granted + 1}–${agents.length} of ${agents.length} were not run. Investigate those focuses with glob, grep and read.`
          : undefined,
        `Helpers left for this investigation: ${options.remaining()}.`,
      ].filter(Boolean);
      return `${notes.join("\n")}\n\n${wrapUntrustedToolResult(
        formatHelperReports(runs, DELEGATE_REPORTS_CHARS),
        DELEGATE_SOURCE,
        DELEGATE_MAX_RESULT_CHARS - DELEGATE_NOTES_CHARS,
      )}`;
    },
  });
}

/**
 * Pull the final assistant text out of a finished explore run. With `questionId` (the
 * id of the run's own question), only what follows that message counts: a follow-up is
 * seeded with the conversation so far, which ends in the previous run's answer, and that
 * is never this run's answer. Text written beside a tool call is narration, so a run
 * stopped after it (nothing written after its last tool call) has no answer.
 */
export function exploreAgentAnswer(
  result: Pick<AgentLoopResult, "messages">,
  questionId?: string,
): string {
  let start = 0;
  if (questionId !== undefined) {
    const question = result.messages.findIndex((message) => message.id === questionId);
    if (question < 0) return "";
    start = question + 1;
  }
  for (let index = result.messages.length - 1; index >= start; index--) {
    const message = result.messages[index];
    if (message?.role !== "assistant") continue;
    // Text beside a tool call is narration ("I'll read the tests"), not an
    // answer; nothing written after the last tool call means no answer yet.
    if (message.parts.some((part) => part.type === "tool-call")) return "";
    const text = message.parts
      .filter((part): part is { type: "text"; content: string } => part.type === "text")
      .map((part) => part.content)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}
