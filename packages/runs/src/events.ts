import type { AgentMessage, AgentMessagePart } from "@cockpit-context/agent-runtime";
import { createEventBus, type EventBus } from "@cockpit-context/jobs/event-bus";

/** API spellings of `AgentRunStatus` (stored SCREAMING_SNAKE_CASE, mapped at the boundary). */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export type RunKind = "main" | "helper" | "summary";
/**
 * Where a live run is, finer than its status: `preparing` = making sure the
 * checkout exists (re-creating a pruned one can take a while), `queued` =
 * waiting for a concurrency slot, `running` = the agent loop, `finishing` =
 * the force-final synthesis (steering is closed).
 */
export type RunPhase = "preparing" | "queued" | "running" | "finishing";
export type TurnRole = "user" | "assistant" | "tool";

export interface RunUsageView {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Integer millionths of a US dollar. */
  costUsdMicros: number;
}

export interface TurnView {
  seq: number;
  role: TurnRole;
  parts: AgentMessagePart[];
  steering: boolean;
}

/**
 * Live events of one conversation, published on {@link runEvents} with the
 * conversation id as the topic. Every event names the run it belongs to;
 * helper runs also carry `parentRunId`. The bus is in-process and never
 * replays: a watcher reads the snapshot (Postgres turns + `liveSnapshot`)
 * first, then subscribes (docs/product.md).
 */
export type RunEvent =
  | { type: "run.started"; runId: string; kind: RunKind; startedAt: string }
  | { type: "run.phase"; runId: string; phase: RunPhase }
  | { type: "turn"; runId: string; parentRunId?: string; turn: TurnView }
  /** The in-flight (not yet finished) assistant message, throttled to ~10/s. */
  | { type: "delta"; runId: string; parentRunId?: string; message: AgentMessage }
  | {
      type: "run.progress";
      runId: string;
      parentRunId?: string;
      iterations: number;
      usage: RunUsageView;
    }
  | {
      type: "helper.started";
      runId: string;
      parentRunId: string;
      index: number;
      focus: string;
    }
  | {
      type: "run.finished";
      runId: string;
      parentRunId?: string;
      status: RunStatus;
      stopReason: string | null;
      answer: string | null;
      error: string | null;
    };

export type RunEventBus = EventBus<RunEvent>;

/** The process-wide bus. One app replica (docs/hosting.md), so in-process is complete. */
export const runEvents: RunEventBus = createEventBus<RunEvent>({ name: "runs" });

/**
 * "Something changed in one of this user's conversations": a hint for live
 * lists (the Ongoing page, the history), published on {@link runActivity}
 * with the owner's id as the topic. It names the conversation and run and
 * the kind of change only; a list re-reads its rows from Postgres. Deltas
 * and turns are not relayed (a list shows neither).
 */
export interface RunActivityEvent {
  conversationId: string;
  runId: string;
  change: "created" | "phase" | "started" | "progress" | "helper" | "finished";
}

export type RunActivityBus = EventBus<RunActivityEvent>;

/** The process-wide activity bus (topic = owner id). */
export const runActivity: RunActivityBus = createEventBus<RunActivityEvent>({
  name: "run-activity",
});
