import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  type AgentMessage,
  type AgentUsage,
  pruneAgentMessages,
} from "@cockpit-context/agent-runtime";
import type { Prisma } from "@cockpit-context/db";
import {
  deriveExploreBudgets,
  type ExploreAgentOptions,
  type ExploreAgentResult,
  type ExploreHelperRun,
  type ExplorePackageInfo,
  type generateCheckoutSummary,
  type generateRepoMap,
  type LspManager,
  type OverviewSource,
  type RepoMap,
  resolveWithinRoot,
  type runExploreAgent,
  sumUsage,
  toRelativeRootPath,
} from "@cockpit-context/explore";
import {
  type ensureRepository,
  isRepoError,
  type materializeCheckout,
  type resolveTarget,
} from "@cockpit-context/repos";

import type { RunConfig } from "./config";
import { RunEngineError } from "./errors";
import {
  type RunActivityBus,
  type RunActivityEvent,
  type RunEvent,
  type RunEventBus,
  type RunKind,
  type RunPhase,
  type RunStatus,
  type RunUsageView,
  runActivity,
  runEvents,
} from "./events";
import { historyFromTurns, messageText } from "./history";
import { MemoryResultStore } from "./result-store";
import { RunScheduler } from "./scheduler";
import { SteeringQueue } from "./steering";
import type {
  CheckoutForRun,
  ConversationForRun,
  ConversationOrigin,
  PackageForRun,
  RunStore,
  RunTrigger,
  RunUpdate,
  SummaryStatus,
} from "./store";
import { LatestThrottle } from "./throttle";
import { TurnWriter } from "./turn-writer";

/**
 * The run engine (docs/product.md): executes the explore agent
 * in-process for conversations and checkout summaries, with
 *
 * - a global and a per-user concurrency cap (excess runs wait `queued`, in order);
 * - every finished turn saved as it happens, live deltas on the in-process bus;
 * - steering, stop, follow-up runs seeded from earlier turns;
 * - a checkout lease held from before the checkout is (re)materialized until
 *   the run ends, released on every exit path;
 * - restart recovery (`recover`) and a draining `shutdown`.
 *
 * One engine per process (`getRunEngine()`); Cockpit Context runs exactly one replica.
 */

export interface RunEngineDeps {
  store: RunStore;
  config: RunConfig;
  repos: {
    resolveTarget: typeof resolveTarget;
    ensureRepository: typeof ensureRepository;
    materializeCheckout: typeof materializeCheckout;
  };
  explore: {
    run: typeof runExploreAgent;
    summarize: typeof generateCheckoutSummary;
    repoMap: typeof generateRepoMap;
  };
  jobs: {
    enqueueSummary(payload: SummaryRequest): Promise<void>;
    enqueuePrune(): Promise<void>;
  };
  /** The process-wide language-server pool (`COCKPIT_CONTEXT_LSP_*`); omitted = no LSP tools. */
  lsp?: LspManager;
  bus?: RunEventBus;
  /** Per-owner change hints for live lists (default: the process-wide `runActivity`). */
  activity?: RunActivityBus;
  now?: () => Date;
  /** Minimum gap between two `delta` events of one run. Default 100 ms (~10/s). */
  deltaIntervalMs?: number;
  /** How often a run renews its checkout lease while it waits and runs. Default 60 s. */
  leaseRenewIntervalMs?: number;
  /**
   * Base backoff between attempts of the last-resort terminal write (a run
   * whose own final write failed). Attempt n waits n × this. Default 200 ms.
   */
  terminalRetryDelayMs?: number;
  /**
   * A summary run ended `failed` (never for `interrupted`). The
   * `checkout.summarize` job has already succeeded by then, so this is where
   * the server raises the operational alert. A throw is logged, not rethrown.
   */
  onSummaryFailed?: (failure: SummaryFailure) => void | Promise<void>;
}

export interface SummaryFailure {
  checkoutId: string;
  runId: string;
  ownerId: string;
  error: string;
}

/** What `summarizeCheckout` did: started a summary run, or skipped it. */
export type SummaryStart = { started: true; runId: string } | { started: false };

export interface SummaryRequest {
  checkoutId: string;
  /** The user whose package needed the checkout; the summary run is theirs. */
  ownerId: string;
  packageId?: string;
  /** Regenerate even a READY or FAILED summary (a user asked). Overrides are untouched. */
  force?: boolean;
}

export interface StartConversationInput {
  ownerId: string;
  packageId: string;
  text: string;
  version?: string | null;
  ref?: string | null;
  origin: ConversationOrigin;
  /** The MCP connection that asked (MCP origin only). */
  mcp?: { agentTokenId?: string | null; grantId?: string | null; label: string };
  signal?: AbortSignal;
}

export interface StartedRun {
  conversationId: string;
  runId: string;
}

export interface StartedConversation extends StartedRun {
  commitSha: string;
  resolvedFrom: string;
  stale?: boolean;
  fetchedAt?: Date | null;
}

/** What a caller (MCP's `get_query_result`, the UI) sees of a run. */
export interface RunSnapshot {
  runId: string;
  conversationId: string | null;
  kind: RunKind;
  status: RunStatus;
  /** Only while the run is live in this process. */
  phase: RunPhase | null;
  answer: string | null;
  stopReason: string | null;
  error: string | null;
  iterations: number;
  usage: RunUsageView;
}

/** The in-memory part of a conversation's live state, for `conversations.watch` snapshots. */
export interface LiveConversationState {
  runs: Array<{
    runId: string;
    parentRunId: string | null;
    kind: RunKind;
    phase: RunPhase;
    iterations: number;
    usage: RunUsageView;
    /** The in-flight assistant message, if one is streaming. */
    partial: AgentMessage | null;
  }>;
}

export interface RunEngine {
  /** Resolve the package's version/ref (cloning or fetching as needed), open a conversation, start its first run. */
  /**
   * The cheap refusals `startConversation` makes before it resolves (which can
   * clone): stopped engine, no model, the owner's queued-run cap. Lets a caller
   * that resolves on its own (MCP answer reuse) refuse first. Throws
   * RunEngineError; reserves nothing.
   */
  assertCanStart(ownerId: string): void;
  startConversation(input: StartConversationInput): Promise<StartedConversation>;
  /** Follow-up in a conversation whose main run finished (`trigger: web_message`). */
  sendMessage(input: {
    ownerId: string;
    conversationId: string;
    text: string;
  }): Promise<StartedRun>;
  /** Steer the live main run; saved at once as a `steering` turn. */
  steer(input: {
    ownerId: string;
    conversationId: string;
    text: string;
  }): Promise<{ runId: string; seq: number }>;
  /** Stop the conversation's live main run. `false` when nothing was running. */
  stop(input: { ownerId: string; conversationId: string }): Promise<boolean>;
  /**
   * Stop every run `ownerId` has in this process, main AND summary, queued or
   * running (an archived or deleted account). A run whose launch is racing
   * this call is stopped at registration, and a summary job that has not
   * started yet never starts a run once the owner may no longer run
   * (`RunStore.ownerMayRun`). Returns how many live runs it aborted.
   */
  stopAllForOwner(ownerId: string): Promise<number>;
  /**
   * Diagnostics: owners with a stop-all generation still held for a launch in
   * flight. Zero once no launch is pending (the bookkeeping never accumulates).
   */
  pendingOwnerStops(): number;
  /** Wait up to `timeoutMs` for a run to finish; returns its snapshot either way. */
  waitForRun(input: {
    ownerId: string;
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<RunSnapshot>;
  liveState(ownerId: string, conversationId: string): LiveConversationState;
  /** Mark the summary PENDING and enqueue `checkout.summarize` (no-op unless it can move). */
  requestCheckoutSummary(request: SummaryRequest): Promise<boolean>;
  /**
   * The `checkout.summarize` job body: starts the summary run and returns
   * without waiting for it. The run records its outcome on the checkout, and
   * a failed one is reported through `onSummaryFailed`.
   */
  summarizeCheckout(request: SummaryRequest, signal?: AbortSignal): Promise<SummaryStart>;
  /** Boot: queued/running runs → interrupted, leases released, orphaned PENDING summaries → NONE. */
  recover(): Promise<number>;
  /** Refuse new runs, interrupt live ones, wait up to `timeoutMs` for them to settle. */
  shutdown(timeoutMs?: number): Promise<boolean>;
  readonly bus: RunEventBus;
  readonly activity: RunActivityBus;
}

const ZERO: AgentUsage = { inputTokens: 0, outputTokens: 0 };
const DEFAULT_DELTA_INTERVAL_MS = 100;
/** Slack on a lease past the run timeout: preparing and synthesis are not inside the agent's budget. */
const LEASE_SLACK_MS = 5 * 60_000;
/** Lease renewal cadence; far inside `LEASE_SLACK_MS`, so a renewed lease never lapses. */
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 60_000;
const MAX_TITLE_LENGTH = 120;
const MAX_ERROR_LENGTH = 2_000;
const DEFAULT_TERMINAL_RETRY_DELAY_MS = 200;
/** Attempts of the last-resort terminal write before the row is left to boot recovery. */
const TERMINAL_WRITE_ATTEMPTS = 3;

/**
 * Why a live run's controller was aborted. `checkout-lost`: a lease renewal
 * found the checkout row gone (an admin force delete), so the run must stop
 * reading its path; it ends `failed` / `checkout-failed`.
 */
type AbortCause = "stop" | "shutdown" | "checkout-lost";

const ABORT_MESSAGES: Record<AbortCause, string> = {
  stop: "Stopped by the user.",
  shutdown: "The server is shutting down.",
  "checkout-lost": "The checkout was removed while the run was using it.",
};

class RunAbort extends Error {
  constructor(readonly cause: AbortCause) {
    super(ABORT_MESSAGES[cause]);
    this.name = "AbortError";
  }
}

/** Steers accepted but never delivered stay saved as steering turns; say so in the log. */
function logUndelivered(runId: string, undelivered: AgentMessage[]): void {
  if (undelivered.length === 0) return;
  console.warn(`[runs] run ${runId} ended with ${undelivered.length} undelivered steer(s)`);
}

type LiveRun = {
  runId: string;
  ownerId: string;
  conversationId: string | null;
  kind: "main" | "summary";
  abort: AbortController;
  steering: SteeringQueue | null;
  phase: RunPhase;
  usage: AgentUsage;
  iterations: number;
  /** In-flight assistant messages by run id (the run itself and its helpers). */
  partials: Map<string, AgentMessage>;
  helpers: Map<string, { iterations: number; usage: AgentUsage }>;
  /**
   * Helper run ids still executing in this process: the row exists and
   * `finishHelper` has not yet attempted its terminal write. The agent may
   * abandon a delegate call at its deadline while the helper goes on, so a
   * helper can outlive its main run's finish; `closeHelpers` leaves these alone.
   */
  liveHelpers: Set<string>;
  /** Background progress writes; awaited before the final update. */
  progress: Promise<void>;
  /** The main run's turn writer (steering turns are saved through it). */
  writer: TurnWriter | null;
  /** The run's row is known not to be queued/running any more (its terminal write landed). */
  terminalSaved: boolean;
  done: Promise<RunSnapshot>;
};

function usageView(usage: AgentUsage): RunUsageView {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    costUsdMicros: costMicros(usage.costUsd),
  };
}

/** USD → integer micro-dollars (the `costUsdMicros` column). Never a float in storage. */
export function costMicros(costUsd: number | undefined): number {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * 1_000_000);
}

function usageColumns(
  usage: AgentUsage,
): Pick<RunUpdate, "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsdMicros"> {
  return usageView(usage);
}

/**
 * The overview a run reads: the run owner's own edited version when they
 * have one (`override`, loaded for that owner only, so one user's text never
 * reaches another user's prompts), else the shared model-written summary.
 * The checkout only ever holds model text, so a previous generated summary
 * is still used while a regeneration is pending or after one failed.
 */
function overviewFor(
  checkout: Pick<CheckoutForRun, "summary">,
  override: string | null,
): { overview: string; overviewSource: OverviewSource } | undefined {
  if (override?.trim()) return { overview: override, overviewSource: "owner" };
  if (checkout.summary?.trim()) return { overview: checkout.summary, overviewSource: "model" };
  return undefined;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line;
}

const REPO_MAP_LIST_KEYS = [
  "languages",
  "manifests",
  "entrypoints",
  "examplePaths",
  "docPaths",
  "topLevel",
  "notablePackages",
  "hints",
] as const;

/** A stored `Checkout.repoMap`, or `null` when it is missing or not repo-map shaped. */
function parseRepoMap(value: unknown): RepoMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  if (typeof record.generatedAt !== "string" || typeof record.rootName !== "string") return null;
  const lists: Partial<Record<(typeof REPO_MAP_LIST_KEYS)[number], string[]>> = {};
  for (const key of REPO_MAP_LIST_KEYS) {
    const list = record[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) return null;
    lists[key] = list;
  }
  return {
    generatedAt: record.generatedAt,
    rootName: record.rootName,
    languages: lists.languages ?? [],
    manifests: lists.manifests ?? [],
    entrypoints: lists.entrypoints ?? [],
    examplePaths: lists.examplePaths ?? [],
    docPaths: lists.docPaths ?? [],
    topLevel: lists.topLevel ?? [],
    notablePackages: lists.notablePackages ?? [],
    hints: lists.hints ?? [],
  };
}

/** Which bus events a live list hears about (deltas and turns are too chatty and say nothing a row shows). */
const ACTIVITY_CHANGE: Partial<Record<RunEvent["type"], RunActivityEvent["change"]>> = {
  "run.phase": "phase",
  "run.started": "started",
  "run.progress": "progress",
  "helper.started": "helper",
  "run.finished": "finished",
};

/**
 * Summary runs count toward the global concurrency cap only, never the
 * owner's per-user cap: a background
 * overview must not take a slot from the user's own questions, nor wait on them.
 */
const SUMMARY_SLOT = { perUser: false } as const;

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "stopped", "interrupted"]);

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const { store, config } = deps;
  const bus = deps.bus ?? runEvents;
  const activity = deps.activity ?? runActivity;
  const now = deps.now ?? (() => new Date());
  const deltaIntervalMs = deps.deltaIntervalMs ?? DEFAULT_DELTA_INTERVAL_MS;
  const scheduler = new RunScheduler({
    global: config.maxConcurrentRuns,
    perUser: config.maxConcurrentRunsPerUser,
  });
  const budgets = deriveExploreBudgets({
    maxIterations: config.maxIterations,
    timeoutMs: config.runTimeoutMs,
  });
  const leaseRenewIntervalMs = deps.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
  const terminalRetryDelayMs = deps.terminalRetryDelayMs ?? DEFAULT_TERMINAL_RETRY_DELAY_MS;
  if (!Number.isInteger(config.maxConcurrentSummaries) || config.maxConcurrentSummaries < 1) {
    throw new Error(
      `maxConcurrentSummaries must be an integer of at least 1, got ${config.maxConcurrentSummaries}.`,
    );
  }
  /**
   * Summary permits, taken before a summary run enters the preparer or the
   * global scheduler and held until it ends. Summaries skip the per-user cap,
   * so without this every pending summary would queue for global slots ahead
   * of later questions; with it at most `maxConcurrentSummaries` do, as when
   * each one held a job-runner slot.
   */
  const summaryPermits = new RunScheduler({
    global: config.maxConcurrentSummaries,
    perUser: config.maxConcurrentSummaries,
  });
  /**
   * Checkout preparation (lease, re-clone/fetch, worktree, repo map) happens
   * before a run waits for its slot, so a queued run starts the moment one
   * frees up. It is bounded by its own caps of the same size, so any number of
   * queued runs never means unbounded concurrent git work.
   */
  const preparer = new RunScheduler({
    global: config.maxConcurrentRuns,
    perUser: config.maxConcurrentRunsPerUser,
  });
  const live = new Map<string, LiveRun>();
  /** Checkouts with a summary run in this process (a forced regenerate never doubles one). */
  const liveSummaries = new Set<string>();
  /** conversation id → its live main run. */
  const liveMain = new Map<string, LiveRun>();
  /** Conversations whose follow-up run is being created (closes the check-then-start race). */
  const startingFollowUps = new Set<string>();
  let stopping = false;
  /**
   * Owner id → how many times `stopAllForOwner` ran for it. A launch reads it
   * before checking `ownerMayRun` and compares at registration, so a run whose
   * launch overlapped a stop-all (it passed the check before the ban, but
   * registered after the stop-all walked `live`) is stopped before it starts.
   */
  const ownerStops = new Map<string, number>();
  /**
   * Owner id → launches between `ownerGate` and registration. While any is
   * pending the owner's `ownerStops` entry is kept (they compare against it);
   * at zero it is dropped, so archived or deleted owners do not accumulate.
   */
  const pendingGates = new Map<string, number>();
  /**
   * Owner id → main-run launches past the queued-run cap check that are not
   * registered in `live` yet. Taken synchronously with the check, so
   * concurrent launches cannot all pass it (COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER).
   */
  const reservedLaunches = new Map<string, number>();

  /** The owner's main runs waiting for a slot: live and not yet running, plus reservations. */
  function waitingMainRuns(ownerId: string): number {
    let waiting = reservedLaunches.get(ownerId) ?? 0;
    for (const run of live.values()) {
      if (
        run.ownerId === ownerId &&
        run.kind === "main" &&
        (run.phase === "preparing" || run.phase === "queued")
      ) {
        waiting += 1;
      }
    }
    return waiting;
  }

  /** BUSY when the owner already has the most waiting main runs allowed. */
  function requireQueueRoom(ownerId: string): void {
    const cap = config.maxQueuedRunsPerUser ?? 0;
    if (cap > 0 && waitingMainRuns(ownerId) >= cap) {
      throw new RunEngineError(
        "BUSY",
        `This account already has ${cap} questions waiting for an investigation slot. Wait for some to finish, then ask again.`,
      );
    }
  }

  /** Check the cap and hold a place until the run is registered; returns the release. */
  function reserveQueueRoom(ownerId: string): () => void {
    requireQueueRoom(ownerId);
    reservedLaunches.set(ownerId, (reservedLaunches.get(ownerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (reservedLaunches.get(ownerId) ?? 1) - 1;
      if (remaining > 0) reservedLaunches.set(ownerId, remaining);
      else reservedLaunches.delete(ownerId);
    };
  }

  interface OwnerGate {
    active: boolean;
    /** Read at registration: the owner is inactive or was stopped since the gate. */
    halted: () => boolean;
    /** Ends this launch's claim on the stop generation (idempotent; call on every path). */
    release: () => void;
  }

  /** Read before a run row is created; `halted()` is checked at registration. */
  async function ownerGate(ownerId: string): Promise<OwnerGate> {
    pendingGates.set(ownerId, (pendingGates.get(ownerId) ?? 0) + 1);
    const stops = ownerStops.get(ownerId) ?? 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (pendingGates.get(ownerId) ?? 1) - 1;
      if (remaining > 0) {
        pendingGates.set(ownerId, remaining);
        return;
      }
      pendingGates.delete(ownerId);
      // No launch compares against the generation any more.
      ownerStops.delete(ownerId);
    };
    let active: boolean;
    try {
      active = await store.ownerMayRun(ownerId);
    } catch (error) {
      release();
      throw error;
    }
    return {
      active,
      halted: () => !active || (ownerStops.get(ownerId) ?? 0) !== stops,
      release,
    };
  }

  const publish = (conversationId: string | null, event: RunEvent) => {
    if (!conversationId) return;
    bus.publish(conversationId, event);
    const change = ACTIVITY_CHANGE[event.type];
    // The main run is registered until after its `run.finished` is published,
    // so every relayed event (helpers' included) still finds its owner here.
    const ownerId = change ? liveMain.get(conversationId)?.ownerId : undefined;
    if (change && ownerId)
      activity.publish(ownerId, { conversationId, runId: event.runId, change });
  };

  const leaseExpiry = () => new Date(now().getTime() + config.runTimeoutMs + LEASE_SLACK_MS);

  /**
   * Keep a run's lease alive from preparation to its end, however long it
   * waits for a slot. `lost` turns true when a renewal finds the checkout row
   * gone, and `onLost` runs once at that moment (the engine aborts the run).
   * `stop()` waits for an in-flight renewal, so no renewal can re-create the
   * lease after the run released it.
   */
  function keepLease(runId: string, checkoutId: string, onLost?: () => void) {
    let inFlight: Promise<void> | null = null;
    const state = { lost: false };
    const renew = (): Promise<void> => {
      const attempt = store
        .acquireLease(runId, checkoutId, leaseExpiry())
        .then((held) => {
          if (held || state.lost) return;
          state.lost = true;
          onLost?.();
        })
        .catch((error: unknown) => {
          console.warn(`[runs] could not renew the lease of run ${runId}`, error);
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = attempt;
      return attempt;
    };
    const timer = setInterval(() => {
      if (!inFlight) void renew();
    }, leaseRenewIntervalMs);
    timer.unref?.();
    return {
      get lost() {
        return state.lost;
      },
      /** Renew now; `false` when the checkout no longer exists. */
      async renewNow(): Promise<boolean> {
        if (inFlight) await inFlight;
        await renew();
        return !state.lost;
      },
      async stop(): Promise<void> {
        clearInterval(timer);
        if (inFlight) await inFlight;
      },
    };
  }

  function requireModel(): { apiKey: string; model: string; helperModel: string } {
    if (!config.apiKey || !config.model) {
      throw new RunEngineError(
        "MODEL_NOT_CONFIGURED",
        "OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL must be set before the agent can run.",
      );
    }
    return {
      apiKey: config.apiKey,
      model: config.model,
      helperModel: config.helperModel ?? config.model,
    };
  }

  function requireRunning(): void {
    if (stopping) throw new RunEngineError("ENGINE_STOPPED", "The server is shutting down.");
  }

  function setPhase(run: LiveRun, phase: RunPhase): void {
    run.phase = phase;
    publish(run.conversationId, { type: "run.phase", runId: run.runId, phase });
  }

  function exploreModelOptions(models: { apiKey: string; model: string; helperModel: string }) {
    return {
      apiKey: models.apiKey,
      model: models.model,
      helperModel: models.helperModel,
      api: config.modelApi,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      stallTimeoutMs: config.modelStallTimeoutMs,
    };
  }

  function lspFor(checkoutId: string): ExploreAgentOptions["lsp"] {
    return deps.lsp?.enabled ? { manager: deps.lsp, checkoutId } : undefined;
  }

  // -------------------------------------------------------------------------
  // Checkout preparation: lease first, then make sure the worktree exists.
  // -------------------------------------------------------------------------

  /** Re-create a pruned checkout row from the conversation's commit. */
  async function recreateCheckoutRow(conversation: ConversationForRun, signal: AbortSignal) {
    if (!conversation.commitSha || !conversation.packageId) {
      throw new PrepareError(
        "package-deleted",
        "The checkout was removed and its package no longer exists, so it cannot be re-created.",
      );
    }
    const pkg = await store.loadPackage(conversation.ownerId, conversation.packageId);
    if (!pkg) {
      throw new PrepareError(
        "package-deleted",
        "The checkout was removed and its package no longer exists, so it cannot be re-created.",
      );
    }
    const repo = await deps.repos.ensureRepository(
      {
        gitUrl: pkg.gitUrl,
        ownerId: pkg.ownerId,
        sshKeyId: pkg.sshKeyId,
        packageId: pkg.id,
        isSnapshot: pkg.isSnapshot,
        repositoryId: pkg.repositoryId,
      },
      { signal },
    );
    const checkoutId = await store.upsertCheckout(
      repo.id,
      conversation.commitSha,
      conversation.resolvedFrom,
    );
    await store.updateConversation(conversation.id, { checkoutId });
    conversation.checkoutId = checkoutId;
    return checkoutId;
  }

  /**
   * Lease the checkout, then materialize it (re-cloning and re-adding the
   * worktree when pruned). The lease comes first so pruning cannot remove the
   * checkout between "it exists" and "the agent reads it".
   */
  async function leaseCheckout(
    runId: string,
    checkoutId: string | null,
    recreate: (() => Promise<string>) | null,
    signal: AbortSignal,
    onLeased: (checkoutId: string) => void,
  ): Promise<{ checkout: CheckoutForRun; path: string; created: boolean }> {
    let id = checkoutId;
    for (let attempt = 0; ; attempt += 1) {
      if (!id) {
        if (!recreate) throw new PrepareError("checkout-failed", "The checkout no longer exists.");
        id = await recreate();
      }
      if (await store.acquireLease(runId, id, leaseExpiry())) break;
      // Pruned between reading its id and leasing it.
      if (attempt >= 1 || !recreate) {
        throw new PrepareError("checkout-failed", "The checkout was removed while preparing.");
      }
      id = null;
    }
    onLeased(id);
    // Only the status: the full row is read once, after materializing.
    const before = await store.loadCheckoutStatus(id);
    const ready = await deps.repos.materializeCheckout(id, { signal });
    const checkout = await store.loadCheckout(id);
    if (!checkout) throw new PrepareError("checkout-failed", "The checkout no longer exists.");
    return { checkout, path: ready.path, created: before !== "ready" };
  }

  /**
   * The checkout's stored repo map, generated and saved on first use. `false`
   * (no map) when generation fails: `true` would make the agent walk the
   * same tree again.
   */
  async function repoMapFor(checkout: CheckoutForRun, root: string): Promise<RepoMap | false> {
    const stored = parseRepoMap(checkout.repoMap);
    if (stored) return stored;
    let map: RepoMap;
    try {
      map = await deps.explore.repoMap(root);
    } catch (error) {
      console.warn(`[runs] could not build the repo map of checkout ${checkout.id}`, error);
      return false;
    }
    // A failed save still hands this run the map it built; the next run retries the save.
    try {
      await store.saveRepoMap(
        checkout.id,
        JSON.parse(JSON.stringify(map)) as Prisma.InputJsonValue,
      );
    } catch (error) {
      console.warn(`[runs] could not save the repo map of checkout ${checkout.id}`, error);
    }
    return map;
  }

  async function afterCheckoutReady(
    checkout: CheckoutForRun,
    created: boolean,
    owner: { ownerId: string; packageId: string | null },
  ): Promise<void> {
    if (created) {
      await deps.jobs.enqueuePrune().catch((error: unknown) => {
        console.warn("[runs] could not enqueue storage.prune", error);
      });
    }
    // No package (deleted): nobody owns a summary request for it.
    if (checkout.summaryStatus === "none" && owner.packageId) {
      await requestCheckoutSummary({
        checkoutId: checkout.id,
        ownerId: owner.ownerId,
        packageId: owner.packageId,
      }).catch((error: unknown) => {
        console.warn("[runs] could not request the checkout summary", error);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Live run bookkeeping
  // -------------------------------------------------------------------------

  function register(
    runId: string,
    ownerId: string,
    conversationId: string | null,
    kind: "main" | "summary",
    execute: (run: LiveRun) => Promise<RunSnapshot>,
    halted = false,
  ): LiveRun {
    let resolveDone: (snapshot: RunSnapshot) => void = () => {};
    const done = new Promise<RunSnapshot>((resolve) => {
      resolveDone = resolve;
    });
    const run: LiveRun = {
      runId,
      ownerId,
      conversationId,
      kind,
      abort: new AbortController(),
      steering: kind === "main" ? new SteeringQueue() : null,
      phase: "preparing",
      usage: ZERO,
      iterations: 0,
      partials: new Map(),
      helpers: new Map(),
      liveHelpers: new Set(),
      progress: Promise.resolve(),
      writer: null,
      terminalSaved: false,
      done,
    };
    live.set(runId, run);
    if (kind === "main" && conversationId) {
      liveMain.set(conversationId, run);
      activity.publish(ownerId, { conversationId, runId, change: "created" });
    }
    // Created while shutdown() was already draining: it never saw this run.
    if (stopping) run.abort.abort(new RunAbort("shutdown"));
    // Its owner was stopped (archived/deleted) while this launch was in flight.
    else if (halted) run.abort.abort(new RunAbort("stop"));
    void (async () => {
      let snapshot: RunSnapshot;
      try {
        snapshot = await execute(run);
      } catch (error) {
        // execute() records its own failures; this is the last-resort net.
        console.error(`[runs] run ${runId} crashed`, error);
        snapshot = emptySnapshot(run, "failed", errorText(error));
      }
      // Nothing below throws: every step catches and logs its own failure.
      run.steering?.close();
      // execute() has settled, so this never races the run's own writes.
      if (!run.terminalSaved) await ensureTerminal(run, snapshot);
      await store.releaseLeases(runId).catch((error: unknown) => {
        console.error(`[runs] could not release the leases of run ${runId}`, error);
      });
      live.delete(runId);
      if (conversationId && liveMain.get(conversationId) === run) liveMain.delete(conversationId);
      resolveDone(snapshot);
    })();
    return run;
  }

  /**
   * The run's own terminal write and its fallback both failed: the row still
   * reads queued/running, which blocks the conversation until a restart. Try
   * a conditional terminal write a few more times (it never overwrites a
   * finished row); if it still fails, boot recovery interrupts the row.
   */
  async function ensureTerminal(run: LiveRun, snapshot: RunSnapshot): Promise<void> {
    const status: RunStatus = TERMINAL.has(snapshot.status) ? snapshot.status : "failed";
    const stopReason = snapshot.stopReason ?? (status === "failed" ? "engine-error" : null);
    for (let attempt = 1; attempt <= TERMINAL_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const written = await store.finishRunIfActive(run.runId, {
          status,
          stopReason,
          error: snapshot.error,
          finishedAt: now(),
        });
        run.terminalSaved = true;
        if (!written) return;
        if (run.kind === "main") await closeHelpers(run, status);
        publish(run.conversationId, {
          type: "run.finished",
          runId: run.runId,
          status,
          stopReason,
          answer: snapshot.answer,
          error: snapshot.error,
        });
        return;
      } catch (error) {
        if (attempt === TERMINAL_WRITE_ATTEMPTS) {
          console.error(
            `[runs] run ${run.runId} could not be marked finished; boot recovery will interrupt it`,
            error,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, terminalRetryDelayMs * attempt));
      }
    }
  }

  /**
   * Helpers of a main run that are still queued/running (their own terminal
   * write in `finishHelper` failed) end with it, as an aborted helper would:
   * interrupted on shutdown, stopped on a user stop, failed otherwise. A
   * helper still executing here (`liveHelpers`) is left alone: it writes its
   * own terminal status when it ends. Best effort: a failure is logged, and
   * boot recovery catches what is left.
   */
  async function closeHelpers(run: LiveRun, mainStatus: RunStatus): Promise<void> {
    // No helper row was ever created for this run, or every one is still live.
    if (run.helpers.size === 0 || run.liveHelpers.size === run.helpers.size) return;
    const status: RunStatus =
      mainStatus === "interrupted" || mainStatus === "stopped" ? mainStatus : "failed";
    try {
      await store.closeActiveHelpers(
        run.runId,
        {
          status,
          stopReason:
            status === "interrupted"
              ? "interrupted"
              : status === "stopped"
                ? "aborted"
                : "engine-error",
          error: status === "failed" ? "The helper's result could not be saved." : null,
          finishedAt: now(),
        },
        [...run.liveHelpers],
      );
    } catch (error) {
      console.warn(`[runs] could not close the helpers of run ${run.runId}`, error);
    }
  }

  function emptySnapshot(run: LiveRun, status: RunStatus, error: string | null): RunSnapshot {
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      kind: run.kind,
      status,
      phase: null,
      answer: null,
      stopReason: null,
      error,
      iterations: run.iterations,
      usage: usageView(run.usage),
    };
  }

  function abortCause(run: LiveRun): AbortCause | null {
    if (!run.abort.signal.aborted) return null;
    const reason: unknown = run.abort.signal.reason;
    return reason instanceof RunAbort ? reason.cause : "stop";
  }

  /** Record per-dispatch usage live: event + a background write of the running totals. */
  function trackUsage(run: LiveRun, usage: AgentUsage): void {
    run.usage = sumUsage(run.usage, usage);
    run.iterations += 1;
    const view = usageView(run.usage);
    const iterations = run.iterations;
    publish(run.conversationId, {
      type: "run.progress",
      runId: run.runId,
      iterations,
      usage: view,
    });
    run.progress = run.progress
      .then(() => store.updateRun(run.runId, { ...view, iterations }))
      .catch((error: unknown) => {
        console.warn(`[runs] could not save progress of run ${run.runId}`, error);
      });
  }

  /** Throttled `delta` events for one (main or helper) run's in-flight assistant message. */
  function deltaStream(run: LiveRun, runId: string, parentRunId?: string) {
    const announced = new Set<string>();
    const throttle = new LatestThrottle<AgentMessage>(deltaIntervalMs, (message) => {
      publish(run.conversationId, {
        type: "delta",
        runId,
        ...(parentRunId ? { parentRunId } : {}),
        message,
      });
    });
    return {
      onMessagesChange(messages: AgentMessage[]) {
        const last = messages.at(-1);
        if (last?.role !== "assistant" || announced.has(last.id)) return;
        run.partials.set(runId, last);
        throttle.push(last);
      },
      /** A turn finished: it is no longer in flight. */
      finished(messageId: string) {
        announced.add(messageId);
        if (run.partials.get(runId)?.id === messageId) {
          run.partials.delete(runId);
          throttle.cancel();
        }
      },
      close() {
        throttle.cancel();
        run.partials.delete(runId);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Main runs
  // -------------------------------------------------------------------------

  type MainRunInput = {
    conversation: ConversationForRun;
    trigger: RunTrigger;
    text: string;
    history: AgentMessage[];
    /** Holds the history's pruned tool results, so they stay retrievable. */
    resultStore?: MemoryResultStore;
    /**
     * The conversation was created just now (its `lastActivityAt` defaults to
     * now), and `pkg` is the package row it was created from, so neither is
     * written or read again.
     */
    created?: { pkg: PackageForRun };
  };

  async function launchMainRun(input: MainRunInput): Promise<StartedRun> {
    // Re-checked here: resolving the target or reading history may have taken
    // long enough for a shutdown to begin.
    requireRunning();
    const models = requireModel();
    const { conversation } = input;
    // Before the run row exists: a failure here leaves no queued row that
    // nothing will ever execute (the conversation would read as busy).
    if (!input.created) {
      await store.updateConversation(conversation.id, { lastActivityAt: now() });
    }
    const gate = await ownerGate(conversation.ownerId);
    try {
      return await createAndRegisterMainRun(input, models, gate);
    } finally {
      gate.release();
    }
  }

  async function createAndRegisterMainRun(
    input: MainRunInput,
    models: { apiKey: string; model: string; helperModel: string },
    gate: OwnerGate,
  ): Promise<StartedRun> {
    const { conversation } = input;
    const runCheckoutId = conversation.checkoutId;
    const { id: runId } = await store.createRun({
      ownerId: conversation.ownerId,
      conversationId: conversation.id,
      parentRunId: null,
      checkoutId: runCheckoutId,
      kind: "main",
      trigger: input.trigger,
      status: "queued",
      model: models.model,
      focus: null,
      startedAt: null,
    });
    const writer = new TurnWriter(
      runId,
      store,
      (turn) => publish(conversation.id, { type: "turn", runId, turn }),
      // The loop announces the history and this user message as seeds.
      { skipSeeds: input.history.length + 1 },
    );
    // Saved before anything can fail, so the question is never lost.
    writer.append(
      { id: `user-${runId}`, role: "user", parts: [{ type: "text", content: input.text }] },
      "user",
    );
    const run = register(
      runId,
      conversation.ownerId,
      conversation.id,
      "main",
      (liveRun) => executeMainRun(liveRun, input, writer, models, runCheckoutId),
      gate.halted(),
    );
    run.writer = writer;
    return { conversationId: conversation.id, runId };
  }

  async function executeMainRun(
    run: LiveRun,
    input: MainRunInput,
    writer: TurnWriter,
    models: { apiKey: string; model: string; helperModel: string },
    runCheckoutId: string | null,
  ): Promise<RunSnapshot> {
    const { conversation } = input;
    const signal = run.abort.signal;
    const resultStore = input.resultStore ?? new MemoryResultStore();
    const master = deltaStream(run, run.runId);
    const helperStreams: Array<{ close(): void }> = [];
    let releasePrep: (() => void) | undefined;
    let releaseSlot: (() => void) | undefined;
    let lease: ReturnType<typeof keepLease> | undefined;
    let pkg: PackageForRun | null = null;
    /** Set once the terminal write landed: nothing may finish the run again. */
    const outcome: { finalized: RunSnapshot | null } = { finalized: null };

    /**
     * Write the run's terminal row, then (best effort) close leftover helpers
     * and touch the conversation, and announce it. `fallback` is the
     * last-resort write after an unexpected failure: conditional on the row
     * still being active, so it never overwrites a finished run.
     */
    const finish = async (
      status: RunStatus,
      fields: { answer?: string | null; stopReason?: string | null; error?: string | null },
      usage: AgentUsage = run.usage,
      iterations = run.iterations,
      fallback = false,
    ): Promise<RunSnapshot> => {
      master.close();
      for (const stream of helperStreams) stream.close();
      await writer.flush();
      await run.progress;
      let snapshot: RunSnapshot = {
        runId: run.runId,
        conversationId: conversation.id,
        kind: "main",
        status,
        phase: null,
        answer: fields.answer ?? null,
        stopReason: fields.stopReason ?? null,
        error: fields.error ?? null,
        iterations,
        usage: usageView(usage),
      };
      const data: RunUpdate = {
        status,
        answer: snapshot.answer,
        stopReason: snapshot.stopReason,
        error: snapshot.error,
        iterations,
        ...usageColumns(usage),
        finishedAt: now(),
      };
      if (!fallback) {
        await store.updateRun(run.runId, data);
      } else if (!(await store.finishRunIfActive(run.runId, data))) {
        // Already finished (an earlier write landed after all): what is saved stands.
        snapshot = await storedSnapshot(run, snapshot);
      }
      run.terminalSaved = true;
      outcome.finalized = snapshot;
      await closeHelpers(run, snapshot.status);
      await store
        .updateConversation(conversation.id, { lastActivityAt: now() })
        .catch((error: unknown) => {
          console.warn(`[runs] could not touch conversation ${conversation.id}`, error);
        });
      publish(conversation.id, {
        type: "run.finished",
        runId: run.runId,
        status: snapshot.status,
        stopReason: snapshot.stopReason,
        answer: snapshot.answer,
        error: snapshot.error,
      });
      return snapshot;
    };

    const stoppedStatus = (): RunStatus =>
      abortCause(run) === "shutdown" ? "interrupted" : "stopped";
    /** The end of an aborted run: stopped/interrupted, or failed when its checkout vanished. */
    const endAborted = (
      answer: string | null = null,
      usage?: AgentUsage,
      iterations?: number,
    ): Promise<RunSnapshot> =>
      abortCause(run) === "checkout-lost"
        ? finish(
            "failed",
            { stopReason: "checkout-failed", error: ABORT_MESSAGES["checkout-lost"] },
            usage,
            iterations,
          )
        : finish(
            stoppedStatus(),
            // A shutdown reads like boot recovery's interruption.
            { answer, stopReason: abortCause(run) === "shutdown" ? "interrupted" : "aborted" },
            usage,
            iterations,
          );
    /** The text of the last finished assistant turn this run saved (seeds excluded). */
    let lastAssistantText = "";

    try {
      // 1. The checkout (re-created when pruned), leased before it is touched.
      setPhase(run, "preparing");
      try {
        releasePrep = await preparer.acquire(conversation.ownerId, signal);
      } catch {
        return await endAborted();
      }
      let prepared: Awaited<ReturnType<typeof leaseCheckout>>;
      try {
        prepared = await leaseCheckout(
          run.runId,
          conversation.checkoutId,
          () => recreateCheckoutRow(conversation, signal),
          signal,
          (checkoutId) => {
            lease = keepLease(run.runId, checkoutId, () =>
              run.abort.abort(new RunAbort("checkout-lost")),
            );
          },
        );
      } catch (error) {
        if (signal.aborted) return await endAborted();
        const known = error instanceof PrepareError ? error : null;
        return await finish("failed", {
          stopReason: known?.stopReason ?? "checkout-failed",
          error: isRepoError(error) ? `${error.code}: ${error.message}` : errorText(error),
        });
      }
      const { checkout, path } = prepared;
      if (checkout.id !== conversation.checkoutId) {
        await store.updateConversation(conversation.id, { checkoutId: checkout.id });
      }
      // The run row was created with the conversation's checkout at the time;
      // only a re-created checkout needs writing.
      if (checkout.id !== runCheckoutId) {
        await store.updateRun(run.runId, { checkoutId: checkout.id });
      }
      await afterCheckoutReady(checkout, prepared.created, {
        ownerId: conversation.ownerId,
        packageId: conversation.packageId,
      });
      const repoMap = await repoMapFor(checkout, path);
      pkg =
        input.created?.pkg ??
        (conversation.packageId
          ? await store.loadPackage(conversation.ownerId, conversation.packageId)
          : null);
      releasePrep();
      releasePrep = undefined;

      // 2. A concurrency slot. The lease is renewed while the run waits, and
      // once more now for the run itself.
      setPhase(run, "queued");
      try {
        releaseSlot = await scheduler.acquire(conversation.ownerId, signal);
      } catch {
        return await endAborted();
      }
      if (!(await lease?.renewNow())) {
        return await finish("failed", {
          stopReason: "checkout-failed",
          error: "The checkout was removed while the run was queued.",
        });
      }

      // 3. The agent.
      const startedAt = now();
      await store.updateRun(run.runId, { status: "running", startedAt });
      setPhase(run, "running");
      publish(conversation.id, {
        type: "run.started",
        runId: run.runId,
        kind: "main",
        startedAt: startedAt.toISOString(),
      });

      const packageInfo: ExplorePackageInfo = {
        identifier: conversation.packageIdentifier,
        commit: checkout.sha,
        ...(conversation.requestedVersion || conversation.requestedRef || conversation.resolvedFrom
          ? {
              versionOrRef:
                conversation.requestedVersion ??
                conversation.requestedRef ??
                conversation.resolvedFrom ??
                undefined,
            }
          : {}),
        ...(pkg?.subdirectory ? { subdirectory: pkg.subdirectory } : {}),
      };
      const overview = overviewFor(
        checkout,
        await store.loadSummaryOverride(checkout.id, conversation.ownerId),
      );

      let result: ExploreAgentResult;
      try {
        result = await deps.explore.run({
          root: path,
          question: input.text,
          history: input.history,
          package: packageInfo,
          ...(pkg?.notes?.trim() ? { userNotes: pkg.notes } : {}),
          ...overview,
          repoMap,
          ...exploreModelOptions(models),
          maxIterations: budgets.maxIterations,
          timeoutMs: budgets.timeoutMs,
          abortSignal: signal,
          lsp: lspFor(checkout.id),
          ripgrep: "auto",
          resultStore,
          cacheKey: `run:${run.runId}`,
          takeSteeringMessages: run.steering?.take,
          onTurn: (turn) => {
            const saved = writer.record(turn);
            master.finished(turn.message.id);
            // Seeds (earlier runs' history, which ends in the previous answer)
            // are announced too but return null: only this run's own turns count.
            if (saved?.role !== "assistant") return;
            const textNow = messageText(turn.message);
            if (textNow) lastAssistantText = textNow;
            // A turn without tool calls ends the loop unless a steer is already
            // queued (the runtime takes once more and dispatches again). Closing
            // an empty queue now means a later steer is refused, not silently
            // accepted after the runtime's last look.
            if (!turn.message.parts.some((part) => part.type === "tool-call")) {
              run.steering?.closeIfEmpty();
            }
          },
          onMessagesChange: master.onMessagesChange,
          onUsage: (usage) => trackUsage(run, usage),
          onSynthesisStart: () => {
            // Nothing reads steering past this point: refuse new steers.
            logUndelivered(run.runId, run.steering?.close() ?? []);
            setPhase(run, "finishing");
          },
          onHelperStart: async (helper) => {
            const helperRun = await startHelper(
              run,
              conversation,
              { checkoutId: checkout.id, trigger: input.trigger, helperModel: models.helperModel },
              helper,
            );
            helperStreams.push(helperRun.stream);
            return helperRun.hooks;
          },
          onHelperFinish: (helper) => finishHelper(run, helper),
        });
      } catch (error) {
        // The main run's own spend, as reported per dispatch (synthesis
        // included). Not `ExploreAgentError.usage`: that adds every helper,
        // and each helper run row already carries its own usage.
        if (signal.aborted) {
          // The last finished assistant text, else the text that was streaming.
          const partial = lastAssistantText || messageText(run.partials.get(run.runId));
          return await endAborted(partial || null);
        }
        return await finish("failed", { stopReason: "model-error", error: errorText(error) });
      } finally {
        // No more steers once the loop has returned, whatever happened. Any
        // still queued were accepted during a final dispatch that left no
        // budget for another; they stay saved as steering turns, so a
        // follow-up's history has them.
        logUndelivered(run.runId, run.steering?.close() ?? []);
      }

      const ownUsage = result.ownUsage;
      if (signal.aborted || result.stopReason === "aborted") {
        // "Ends stopped with whatever answer exists": the last finished
        // assistant text, else the text that was streaming.
        const partial =
          result.answer || lastAssistantText || messageText(run.partials.get(run.runId));
        return await endAborted(partial || null, ownUsage, result.iterations);
      }
      if (!result.answer) {
        return await finish(
          "failed",
          {
            stopReason: result.stopReason,
            error: result.synthesisError ?? "The agent stopped without writing an answer.",
          },
          ownUsage,
          result.iterations,
        );
      }
      return await finish(
        "completed",
        { answer: result.answer, stopReason: result.stopReason },
        ownUsage,
        result.iterations,
      );
    } catch (error) {
      // The run already finished (a later best-effort step threw): keep that outcome.
      if (outcome.finalized) return outcome.finalized;
      // An unexpected failure (Postgres, a bug): still close the run out.
      console.error(`[runs] main run ${run.runId} failed`, error);
      return await finish(
        "failed",
        { stopReason: "engine-error", error: errorText(error) },
        undefined,
        undefined,
        true,
      ).catch((fallbackError: unknown) => {
        // `register` retries a conditional terminal write once this settles.
        console.error(`[runs] could not finish main run ${run.runId}`, fallbackError);
        return emptySnapshot(run, "failed", errorText(error));
      });
    } finally {
      releasePrep?.();
      await lease?.stop();
      releaseSlot?.();
    }
  }

  /** A finished run's saved outcome (phase cleared), or `fallback` when it cannot be read. */
  async function storedSnapshot(run: LiveRun, fallback: RunSnapshot): Promise<RunSnapshot> {
    try {
      return { ...(await snapshotFromStore(run.ownerId, run.runId)), phase: null };
    } catch (error) {
      console.warn(`[runs] could not read back run ${run.runId}`, error);
      return fallback;
    }
  }

  async function startHelper(
    run: LiveRun,
    conversation: ConversationForRun,
    context: { checkoutId: string; trigger: RunTrigger; helperModel: string },
    helper: { index: number; focus: string; question: string },
  ) {
    const { id: helperRunId } = await store.createRun({
      ownerId: conversation.ownerId,
      conversationId: conversation.id,
      parentRunId: run.runId,
      checkoutId: context.checkoutId,
      kind: "helper",
      trigger: context.trigger,
      status: "running",
      model: context.helperModel,
      focus: helper.focus.slice(0, 500),
      startedAt: now(),
    });
    // Live until `finishHelper` attempts its terminal write.
    run.liveHelpers.add(helperRunId);
    const parentRunId = run.runId;
    const writer = new TurnWriter(helperRunId, store, (turn) =>
      publish(conversation.id, { type: "turn", runId: helperRunId, parentRunId, turn }),
    );
    const stream = deltaStream(run, helperRunId, parentRunId);
    const state = { iterations: 0, usage: ZERO, writer };
    run.helpers.set(helperRunId, state);
    helperWriters.set(helperRunId, writer);
    publish(conversation.id, {
      type: "helper.started",
      runId: helperRunId,
      parentRunId,
      index: helper.index,
      focus: helper.focus,
    });
    return {
      stream,
      hooks: {
        helperRunId,
        onTurn: (turn: Parameters<TurnWriter["record"]>[0]) => {
          writer.record(turn);
          stream.finished(turn.message.id);
        },
        onMessagesChange: stream.onMessagesChange,
        onUsage: (usage: AgentUsage) => {
          state.usage = sumUsage(state.usage, usage);
          state.iterations += 1;
          publish(conversation.id, {
            type: "run.progress",
            runId: helperRunId,
            parentRunId,
            iterations: state.iterations,
            usage: usageView(state.usage),
          });
        },
      },
    };
  }

  /** Helper writers by helper run id, so `finishHelper` can flush before the final update. */
  const helperWriters = new Map<string, TurnWriter>();

  async function finishHelper(run: LiveRun, helper: ExploreHelperRun): Promise<void> {
    const helperRunId = helper.helperRunId;
    if (!helperRunId) return;
    try {
      await writeHelperOutcome(run, helperRunId, helper);
    } finally {
      // Its terminal write was attempted: landed or not, the helper is no
      // longer live, so a main run finishing after this closes a row left active.
      run.liveHelpers.delete(helperRunId);
    }
  }

  async function writeHelperOutcome(
    run: LiveRun,
    helperRunId: string,
    helper: ExploreHelperRun,
  ): Promise<void> {
    const writer = helperWriters.get(helperRunId);
    helperWriters.delete(helperRunId);
    run.partials.delete(helperRunId);
    await writer?.flush();
    const cause = abortCause(run);
    const status: RunStatus =
      helper.stopReason === "aborted" || (cause && !helper.answer)
        ? cause === "shutdown"
          ? "interrupted"
          : cause === "checkout-lost"
            ? "failed"
            : "stopped"
        : helper.error && !helper.answer
          ? "failed"
          : "completed";
    // A shutdown reads like boot recovery's interruption, as for the main run.
    const stopReason = status === "interrupted" ? "interrupted" : (helper.stopReason ?? null);
    await store.updateRun(helperRunId, {
      status,
      stopReason,
      error: helper.error ? errorText(helper.error) : null,
      answer: helper.answer || null,
      iterations: helper.iterations,
      ...usageColumns(helper.usage),
      finishedAt: now(),
    });
    publish(run.conversationId, {
      type: "run.finished",
      runId: helperRunId,
      parentRunId: run.runId,
      status,
      stopReason,
      answer: helper.answer || null,
      error: helper.error ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Summary runs (`checkout.summarize`)
  // -------------------------------------------------------------------------

  async function requestCheckoutSummary(request: SummaryRequest): Promise<boolean> {
    // The requester spends their budget on it and replaces the shared
    // generated summary: they must own a package on its repository.
    if (!(await store.ownsCheckout(request.ownerId, request.checkoutId, request.packageId))) {
      throw new RunEngineError("CHECKOUT_NOT_FOUND", "Checkout not found.");
    }
    // A forced regenerate may also rescue a PENDING summary whose job died
    // (unless its summary run is live here right now).
    if (request.force && liveSummaries.has(request.checkoutId)) return false;
    const from: SummaryStatus[] = request.force ? ["none", "pending", "failed", "ready"] : ["none"];
    if (!(await store.markSummaryPending(request.checkoutId, from))) return false;
    try {
      await deps.jobs.enqueueSummary(request);
      return true;
    } catch (error) {
      // Never leave a summary PENDING with no job behind it.
      await store.finishSummary(request.checkoutId, { status: "none" }).catch(() => {});
      throw error;
    }
  }

  /**
   * Start the summary run and return without waiting for it: a summary can
   * wait minutes for a slot and then run for minutes, and the job must not
   * hold a job-runner slot all that time. The run itself records its outcome
   * on the checkout (`finish`); a `failed` one is reported through
   * `onSummaryFailed`. An `interrupted` one (shutdown) is put back to NONE
   * and reported nowhere: the next run that reads the checkout asks again.
   * The job's signal only matters before the run starts; once it is live,
   * `shutdown()` interrupts it like any other run.
   */
  async function summarizeCheckout(
    request: SummaryRequest,
    signal?: AbortSignal,
  ): Promise<SummaryStart> {
    // The job is single-attempt, and runs only request a summary from NONE:
    // a failure here must not leave it PENDING with nothing behind it.
    const release = async () => {
      if (liveSummaries.has(request.checkoutId)) return;
      await store.finishSummary(request.checkoutId, { status: "none" }).catch((error: unknown) => {
        console.warn(`[runs] could not reset the summary of checkout ${request.checkoutId}`, error);
      });
    };
    let target: Awaited<ReturnType<RunStore["loadSummaryTarget"]>>;
    try {
      target = await store.loadSummaryTarget(request.checkoutId);
    } catch (error) {
      // A live summary run here owns the PENDING state (`release` leaves it alone).
      await release();
      throw error;
    }
    // Already written or regenerated elsewhere: nothing to do.
    if (target?.summaryStatus !== "pending") return { started: false };
    // A second job for the same checkout (a forced regenerate while one ran).
    if (liveSummaries.has(target.id)) return { started: false };
    if (!config.apiKey || !config.model || stopping || signal?.aborted) {
      // Back to NONE so the next run requests it again once a model is configured.
      await store.finishSummary(target.id, { status: "none" });
      return { started: false };
    }
    // An archived or deleted owner's queued summary job never starts a run
    // (and so never spends model budget): back to NONE for the next requester.
    // Reserved before any await, so a concurrent job for the same checkout
    // sees it (the check above and this add are one synchronous step).
    liveSummaries.add(target.id);
    let gate: OwnerGate;
    try {
      gate = await ownerGate(request.ownerId);
    } catch (error) {
      liveSummaries.delete(target.id);
      await release();
      throw error;
    }
    let run: LiveRun;
    try {
      if (!gate.active) {
        liveSummaries.delete(target.id);
        await store.finishSummary(target.id, { status: "none" });
        return { started: false };
      }
      run = await startSummaryRun(request, target, gate.halted);
    } catch (error) {
      liveSummaries.delete(target.id);
      await release();
      throw error;
    } finally {
      gate.release();
    }
    void run.done.then((snapshot) => summaryEnded(target.id, run, snapshot));
    return { started: true, runId: run.runId };
  }

  async function summaryEnded(
    checkoutId: string,
    run: LiveRun,
    snapshot: RunSnapshot,
  ): Promise<void> {
    liveSummaries.delete(checkoutId);
    if (snapshot.status !== "failed" || !deps.onSummaryFailed) return;
    try {
      await deps.onSummaryFailed({
        checkoutId,
        runId: run.runId,
        ownerId: run.ownerId,
        error: snapshot.error ?? "Summary run ended failed.",
      });
    } catch (error) {
      console.error(`[runs] could not report the failed summary run ${run.runId}`, error);
    }
  }

  async function startSummaryRun(
    request: SummaryRequest,
    target: CheckoutForRun & { remoteKey: string },
    halted: () => boolean,
  ): Promise<LiveRun> {
    const models = requireModel();
    const pkg = request.packageId
      ? await store.loadPackage(request.ownerId, request.packageId)
      : null;
    const { id: runId } = await store.createRun({
      ownerId: request.ownerId,
      conversationId: null,
      parentRunId: null,
      checkoutId: target.id,
      kind: "summary",
      trigger: "summary",
      status: "queued",
      model: models.model,
      focus: null,
      startedAt: null,
    });
    return register(
      runId,
      request.ownerId,
      null,
      "summary",
      (liveRun) => executeSummaryRun(liveRun, target, pkg, models),
      halted(),
    );
  }

  async function executeSummaryRun(
    run: LiveRun,
    target: CheckoutForRun & { remoteKey: string },
    pkg: PackageForRun | null,
    models: { apiKey: string; model: string; helperModel: string },
  ): Promise<RunSnapshot> {
    const signal = run.abort.signal;
    const writer = new TurnWriter(run.runId, store, () => {});
    let releasePermit: (() => void) | undefined;
    let releasePrep: (() => void) | undefined;
    let releaseSlot: (() => void) | undefined;
    let lease: ReturnType<typeof keepLease> | undefined;
    /** Set once the terminal write landed: nothing may finish the run again. */
    const outcome: {
      finalized: RunSnapshot | null;
      /** Once the READY summary is written, the run's outcome is that summary. */
      summarySaved: { answer: string; stopReason: string | null } | null;
    } = { finalized: null, summarySaved: null };
    /** Put a summary this run will not write back (FAILED or NONE). Best effort. */
    const releaseSummary = async (status: RunStatus) => {
      if (status === "completed" || outcome.summarySaved !== null) return;
      await store
        .finishSummary(target.id, { status: status === "failed" ? "failed" : "none" })
        .catch((error: unknown) => {
          console.warn(`[runs] could not reset the summary of checkout ${target.id}`, error);
        });
    };
    /** As the main run's `finish`; `fallback` never overwrites a finished row. */
    const finish = async (
      status: RunStatus,
      fields: { answer?: string | null; stopReason?: string | null; error?: string | null },
      usage: AgentUsage = run.usage,
      iterations = run.iterations,
      fallback = false,
    ): Promise<RunSnapshot> => {
      await writer.flush();
      await run.progress;
      let snapshot: RunSnapshot = {
        ...emptySnapshot(run, status, fields.error ?? null),
        answer: fields.answer ?? null,
        stopReason: fields.stopReason ?? null,
        iterations,
        usage: usageView(usage),
      };
      const data: RunUpdate = {
        status,
        answer: snapshot.answer,
        stopReason: snapshot.stopReason,
        error: snapshot.error,
        iterations,
        ...usageColumns(usage),
        finishedAt: now(),
      };
      if (!fallback) {
        await store.updateRun(run.runId, data);
      } else if (!(await store.finishRunIfActive(run.runId, data))) {
        snapshot = await storedSnapshot(run, snapshot);
      }
      run.terminalSaved = true;
      outcome.finalized = snapshot;
      await releaseSummary(snapshot.status);
      return snapshot;
    };
    /** The end of an aborted summary run: interrupted, or failed when its checkout vanished. */
    const endAborted = (usage?: AgentUsage, iterations?: number): Promise<RunSnapshot> =>
      abortCause(run) === "checkout-lost"
        ? finish(
            "failed",
            { stopReason: "checkout-failed", error: ABORT_MESSAGES["checkout-lost"] },
            usage,
            iterations,
          )
        : finish(
            "interrupted",
            { stopReason: abortCause(run) === "shutdown" ? "interrupted" : "aborted" },
            usage,
            iterations,
          );
    try {
      setPhase(run, "preparing");
      try {
        releasePermit = await summaryPermits.acquire(run.ownerId, signal, SUMMARY_SLOT);
        releasePrep = await preparer.acquire(run.ownerId, signal, SUMMARY_SLOT);
      } catch {
        return await endAborted();
      }
      let prepared: Awaited<ReturnType<typeof leaseCheckout>>;
      try {
        prepared = await leaseCheckout(run.runId, target.id, null, signal, (checkoutId) => {
          lease = keepLease(run.runId, checkoutId, () =>
            run.abort.abort(new RunAbort("checkout-lost")),
          );
        });
      } catch (error) {
        if (signal.aborted) return await endAborted();
        return await finish("failed", { stopReason: "checkout-failed", error: errorText(error) });
      }
      const repoMap = await repoMapFor(prepared.checkout, prepared.path);
      releasePrep();
      releasePrep = undefined;
      setPhase(run, "queued");
      try {
        releaseSlot = await scheduler.acquire(run.ownerId, signal, SUMMARY_SLOT);
      } catch {
        return await endAborted();
      }
      if (!(await lease?.renewNow())) {
        return await finish("failed", {
          stopReason: "checkout-failed",
          error: "The checkout was removed while the summary run was queued.",
        });
      }
      await store.updateRun(run.runId, { status: "running", startedAt: now() });
      setPhase(run, "running");

      // The summary is shared by every user of the checkout, so nothing one
      // user chose reaches its prompt as trusted text: the identifier comes
      // from the repository, and the package's subdirectory only when it is an
      // existing directory of this worktree.
      const identifier = `git:${target.remoteKey.replace(/^[a-z]+:\/\//i, "")}`;
      const subdirectory = checkoutSubdirectory(prepared.path, pkg?.subdirectory);
      let result: Awaited<ReturnType<typeof generateCheckoutSummary>>;
      try {
        result = await deps.explore.summarize({
          root: prepared.path,
          package: {
            identifier,
            commit: target.sha,
            ...(subdirectory ? { subdirectory } : {}),
          },
          repoMap,
          ...exploreModelOptions(models),
          maxIterations: budgets.summaryMaxIterations,
          timeoutMs: budgets.summaryTimeoutMs,
          abortSignal: signal,
          lsp: lspFor(target.id),
          ripgrep: "auto",
          resultStore: new MemoryResultStore(),
          cacheKey: `summary:${target.id}`,
          onTurn: (turn) => {
            writer.record(turn);
          },
          onUsage: (usage) => trackUsage(run, usage),
        });
      } catch (error) {
        // Spend as reported per dispatch (summaries never delegate).
        if (signal.aborted) return await endAborted();
        return await finish("failed", { stopReason: "model-error", error: errorText(error) });
      }
      const summary = result.summary.trim();
      if (signal.aborted || result.stopReason === "aborted") {
        return await endAborted(result.usage, result.iterations);
      }
      if (!summary) {
        return await finish(
          "failed",
          { stopReason: result.stopReason, error: "The agent wrote no summary." },
          result.usage,
          result.iterations,
        );
      }
      // Conditional on PENDING (another job may have finished it meanwhile).
      // Users' overrides live in their own table and are never touched.
      await store.finishSummary(target.id, {
        status: "ready",
        summary,
        model: result.model,
        generatedAt: now(),
      });
      outcome.summarySaved = { answer: summary, stopReason: result.stopReason };
      return await finish(
        "completed",
        { answer: summary, stopReason: result.stopReason },
        result.usage,
        result.iterations,
      );
    } catch (error) {
      // The run already finished (a later best-effort step threw): keep that outcome.
      if (outcome.finalized) return outcome.finalized;
      console.error(`[runs] summary run ${run.runId} failed`, error);
      // The summary is READY: the run did its job, so it completes (no failure alert).
      const saved = outcome.summarySaved;
      const status: RunStatus = saved ? "completed" : "failed";
      const fields = saved ?? { stopReason: "engine-error", error: errorText(error) };
      return await finish(status, fields, undefined, undefined, true).catch(
        async (fallbackError: unknown) => {
          // `register` retries a conditional terminal write once this settles.
          console.error(`[runs] could not finish summary run ${run.runId}`, fallbackError);
          await releaseSummary(status);
          return saved
            ? { ...emptySnapshot(run, "completed", null), ...saved }
            : emptySnapshot(run, "failed", errorText(error));
        },
      );
    } finally {
      releasePrep?.();
      await lease?.stop();
      releaseSlot?.();
      releasePermit?.();
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function snapshotFromStore(ownerId: string, runId: string): Promise<RunSnapshot> {
    const row = await store.getRun(ownerId, runId);
    if (!row) throw new RunEngineError("RUN_NOT_FOUND", "Run not found.");
    const current = live.get(runId);
    return {
      runId: row.id,
      conversationId: row.conversationId,
      kind: row.kind,
      status: row.status,
      phase: current?.phase ?? null,
      answer: row.answer,
      stopReason: row.stopReason,
      error: row.error,
      iterations: current?.iterations ?? row.iterations,
      usage: current
        ? usageView(current.usage)
        : {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens,
            costUsdMicros: row.costUsdMicros,
          },
    };
  }

  return {
    bus,
    activity,

    assertCanStart(ownerId) {
      requireRunning();
      requireModel();
      requireQueueRoom(ownerId);
    },

    async startConversation(input) {
      requireRunning();
      requireModel();
      // Refuse before resolving (which can clone); re-checked with a reservation below.
      requireQueueRoom(input.ownerId);
      const pkg = await store.loadPackage(input.ownerId, input.packageId);
      if (!pkg) throw new RunEngineError("PACKAGE_NOT_FOUND", "Package not found.");
      // Resolution errors (unknown version with nearest tags, host key, …)
      // reach the caller as RepoError, before anything is created.
      const target = await deps.repos.resolveTarget({
        package: pkg,
        version: input.version ?? null,
        ref: input.ref ?? null,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // Resolution can clone or fetch for a long time: no conversation is
      // opened if a shutdown began meanwhile, or once the queue filled up.
      requireRunning();
      const releaseQueueRoom = reserveQueueRoom(input.ownerId);
      try {
        const checkoutId = await store.upsertCheckout(
          target.repositoryId,
          target.sha,
          target.resolvedFrom,
        );
        const conversation = await store.createConversation({
          ownerId: input.ownerId,
          packageId: pkg.id,
          packageIdentifier: pkg.identifier,
          requestedVersion: input.version ?? null,
          requestedRef: input.ref ?? null,
          checkoutId,
          commitSha: target.sha,
          resolvedFrom: target.resolvedFrom,
          origin: input.origin,
          mcpAgentTokenId: input.origin === "mcp" ? (input.mcp?.agentTokenId ?? null) : null,
          mcpGrantId: input.origin === "mcp" ? (input.mcp?.grantId ?? null) : null,
          mcpConnectionLabel: input.origin === "mcp" ? (input.mcp?.label ?? null) : null,
          title: titleFrom(input.text) || pkg.identifier,
        });
        const started = await launchMainRun({
          conversation,
          trigger: input.origin === "mcp" ? "mcp_query" : "web_message",
          text: input.text,
          history: [],
          created: { pkg },
        });
        return {
          ...started,
          commitSha: target.sha,
          resolvedFrom: target.resolvedFrom,
          ...(target.stale ? { stale: true, fetchedAt: target.fetchedAt ?? null } : {}),
        };
      } finally {
        releaseQueueRoom();
      }
    },

    async sendMessage(input) {
      requireRunning();
      requireModel();
      const conversation = await store.loadConversation(input.ownerId, input.conversationId);
      if (!conversation) {
        throw new RunEngineError("CONVERSATION_NOT_FOUND", "Conversation not found.");
      }
      const latest = await store.latestMainRun(conversation.id);
      // No await between this check and the reservation below.
      if (
        liveMain.has(conversation.id) ||
        startingFollowUps.has(conversation.id) ||
        (latest && !TERMINAL.has(latest.status))
      ) {
        throw new RunEngineError(
          "RUN_ACTIVE",
          "The agent is still working on this conversation; steer it instead.",
        );
      }
      const releaseQueueRoom = reserveQueueRoom(conversation.ownerId);
      startingFollowUps.add(conversation.id);
      try {
        const turns = await store.listHistoryTurns(conversation.id);
        const history = historyFromTurns(turns);
        // The previous runs finished long ago: their prefix cache is cold, so
        // offload big old tool results now (they stay retrievable this run).
        const resultStore = new MemoryResultStore();
        await pruneAgentMessages(history, resultStore, { lastDispatchAt: 0 });
        return await launchMainRun({
          conversation,
          trigger: "web_message",
          text: input.text,
          history,
          resultStore,
        });
      } finally {
        startingFollowUps.delete(conversation.id);
        releaseQueueRoom();
      }
    },

    async steer(input) {
      const run = liveMain.get(input.conversationId);
      if (!run || run.ownerId !== input.ownerId) {
        const conversation = await store.loadConversation(input.ownerId, input.conversationId);
        if (!conversation) {
          throw new RunEngineError("CONVERSATION_NOT_FOUND", "Conversation not found.");
        }
        throw new RunEngineError("RUN_FINISHED", "The run has finished; send a follow-up instead.");
      }
      const message = run.steering?.push(input.text);
      if (!message) {
        throw new RunEngineError("RUN_FINISHED", "The run has finished; send a follow-up instead.");
      }
      // Saved (and published) at once so the UI shows it; the loop's later
      // announcement of the same message is skipped by id.
      const view = run.writer?.append(message, "user", true);
      return { runId: run.runId, seq: view?.seq ?? -1 };
    },

    async stop(input) {
      const run = liveMain.get(input.conversationId);
      if (!run || run.ownerId !== input.ownerId) {
        const conversation = await store.loadConversation(input.ownerId, input.conversationId);
        if (!conversation) {
          throw new RunEngineError("CONVERSATION_NOT_FOUND", "Conversation not found.");
        }
        return false;
      }
      run.steering?.close();
      run.abort.abort(new RunAbort("stop"));
      return true;
    },

    async stopAllForOwner(ownerId) {
      // Only a pending launch compares against the generation; with none, a
      // later launch reads the ban (`ownerMayRun`) instead, so keep nothing.
      if (pendingGates.has(ownerId)) ownerStops.set(ownerId, (ownerStops.get(ownerId) ?? 0) + 1);
      else ownerStops.delete(ownerId);
      let aborted = 0;
      for (const run of live.values()) {
        if (run.ownerId !== ownerId || run.abort.signal.aborted) continue;
        run.steering?.close();
        run.abort.abort(new RunAbort("stop"));
        aborted += 1;
      }
      return aborted;
    },

    pendingOwnerStops() {
      return ownerStops.size;
    },

    async waitForRun(input) {
      const run = live.get(input.runId);
      if (run && run.ownerId === input.ownerId) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, input.timeoutMs));
          timer.unref?.();
        });
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<null>((resolve) => {
          if (input.signal?.aborted) resolve(null);
          onAbort = () => resolve(null);
          input.signal?.addEventListener("abort", onAbort, { once: true });
        });
        const settled = await Promise.race([run.done, timeout, aborted]);
        clearTimeout(timer);
        // A long-lived signal (MCP progress polling) must not collect listeners.
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        if (settled) return settled;
      }
      return snapshotFromStore(input.ownerId, input.runId);
    },

    liveState(ownerId, conversationId) {
      const runs: LiveConversationState["runs"] = [];
      const main = liveMain.get(conversationId);
      if (!main || main.ownerId !== ownerId) return { runs };
      runs.push({
        runId: main.runId,
        parentRunId: null,
        kind: "main",
        phase: main.phase,
        iterations: main.iterations,
        usage: usageView(main.usage),
        partial: main.partials.get(main.runId) ?? null,
      });
      for (const [helperRunId, helper] of main.helpers) {
        if (!helperWriters.has(helperRunId)) continue;
        runs.push({
          runId: helperRunId,
          parentRunId: main.runId,
          kind: "helper",
          phase: "running",
          iterations: helper.iterations,
          usage: usageView(helper.usage),
          partial: main.partials.get(helperRunId) ?? null,
        });
      }
      return { runs };
    },

    requestCheckoutSummary,
    summarizeCheckout,

    async recover() {
      const interrupted = await store.interruptOrphanRuns(now(), [...live.keys()]);
      // PENDING summaries nothing will finish (a summarize job that died
      // before or while starting its run) go back to NONE. Best effort.
      await store.resetOrphanSummaries().catch((error: unknown) => {
        console.warn("[runs] could not reset orphaned pending summaries", error);
      });
      return interrupted;
    },

    async shutdown(timeoutMs = 10_000) {
      stopping = true;
      const pending = [...live.values()];
      for (const run of pending) {
        run.steering?.close();
        run.abort.abort(new RunAbort("shutdown"));
      }
      const disposeLsp = () =>
        deps.lsp?.dispose().catch((error: unknown) => {
          console.warn("[runs] could not stop the language servers", error);
        });
      if (pending.length === 0) {
        await disposeLsp();
        return true;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      });
      const settled = await Promise.race([
        Promise.all(pending.map((run) => run.done)).then(() => true as const),
        timedOut,
      ]);
      clearTimeout(timer);
      await disposeLsp();
      return settled;
    },
  };
}

/**
 * A package's subdirectory as a path relative to the checkout `root`, or
 * `undefined` unless it names an existing directory inside it (absolute paths,
 * `..` escapes and symlinks out of the worktree are dropped).
 */
export function checkoutSubdirectory(
  root: string,
  subdirectory: string | null | undefined,
): string | undefined {
  const requested = subdirectory?.trim();
  if (!requested || isAbsolute(requested)) return undefined;
  try {
    const resolved = resolveWithinRoot(root, requested);
    if (!statSync(resolved).isDirectory()) return undefined;
    const relative = toRelativeRootPath(root, resolved);
    return relative === "." ? undefined : relative;
  } catch {
    return undefined;
  }
}

/** A preparation failure with the stop reason the UI translates. */
class PrepareError extends Error {
  constructor(
    readonly stopReason: "package-deleted" | "checkout-failed",
    message: string,
  ) {
    super(message);
    this.name = "PrepareError";
  }
}
