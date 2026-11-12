import type { z } from "zod";

export type AgentMessagePart =
  | { type: "text"; content: string; metadata?: unknown }
  | {
      type: "tool-call";
      id: string;
      name: string;
      arguments: string;
      state: string;
      output?: unknown;
    }
  | { type: "tool-result"; toolCallId: string; content: string; state: string; error?: string }
  | { type: "thinking"; content: string }
  | { type: string; [key: string]: unknown };

export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: AgentMessagePart[];
  createdAt?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Billed cost in USD, when the provider reports it (OpenRouter's `usage.cost`). */
  costUsd?: number;
  /** Cached (read) input tokens the provider billed at the cache-hit rate, when reported. */
  cachedInputTokens?: number;
  /** Input tokens written to a new cache entry, when the provider reports it separately. */
  cacheCreationInputTokens?: number;
  /** Model id that actually served this successful dispatch (may be a fallback). */
  model?: string;
}

export interface StreamEvent {
  type: "chunk" | "message" | "status";
  seq: number;
  data: unknown;
}

/**
 * The wire protocol the runtime speaks to the model endpoint. OpenRouter serves all
 * three, and so does any gateway that copies its API:
 *
 * - `chat-completions`: OpenAI Chat Completions, `POST {baseUrl}/chat/completions`.
 * - `responses`: OpenAI Responses, `POST {baseUrl}/responses`.
 * - `messages`: Anthropic Messages, `POST {baseUrl}/messages`.
 */
export type ModelApi = "chat-completions" | "responses" | "messages";

export interface AgentModel {
  api: ModelApi;
  /** Model id as the endpoint names it (OpenRouter: `anthropic/claude-haiku-4.5`). */
  model: string;
  apiKey: string;
  /**
   * API root that ends in `/v1`; the protocol's path is appended to it. Defaults to
   * OpenRouter (`https://openrouter.ai/api/v1`).
   */
  baseUrl?: string;
  /**
   * Longest one request to this model may go without sending any data, in ms.
   * Before the first chunk a stall counts as a transient failure (retried, then
   * failed over); after it, the dispatch fails. Unset: no stall timeout, only
   * the loop's wall-clock deadline.
   */
  stallTimeoutMs?: number;
}

export interface AgentTool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  maxResultChars: number;
  /**
   * When true, the tool's result is untrusted source material (e.g. fetched web
   * content). If the result overflows into the {@link ResultStore}, every slice
   * returned by `retrieve_tool_result` is re-wrapped with the untrusted-content
   * markers so the prompt-injection defense is never bypassed.
   */
  untrusted?: boolean;
  /**
   * Run the tool.
   *
   * `signal` is the run's abort signal — it fires when the wall-clock deadline
   * elapses or the caller cancels. Forward it to `fetch`, a driver, or a child
   * process so long work actually stops; the loop abandons the call at that
   * moment either way (see `executeToolWithAbort`), and an abandoned tool's
   * eventual result is discarded, never written back into the conversation.
   */
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown> | unknown;
}

/** A full tool-result body plus whether it must be treated as untrusted data. */
export interface StoredResult {
  body: string;
  untrusted: boolean;
}

/** A bounded, clamped window into a {@link StoredResult}. */
export interface ResultSlice {
  /** The clamped `[offset, offset + returned)` slice of the stored body. */
  slice: string;
  /** Actual start offset after clamping to `[0, total]`. */
  offset: number;
  /** Total length of the stored body in characters. */
  total: number;
  /** Whether the stored entry is untrusted (drives re-wrapping on retrieve). */
  untrusted: boolean;
  /** True when the returned slice does not reach the end of the body. */
  hasMore: boolean;
}

/**
 * Transient store for tool-result bodies that overflow a tool's `maxResultChars`.
 * The runtime depends only on this interface; the host injects an
 * implementation (in Cockpit Context: in-process or Postgres-backed — there is no Redis)
 * keyed/namespaced per run or session. Implementations own their
 * own TTL and key namespacing.
 */
export interface ResultStore {
  /** Store the full body under an opaque, caller-provided (content-hash) id. */
  put(id: string, entry: StoredResult): Promise<void>;
  /**
   * Return a clamped window of the stored body, or `null` when the id is unknown
   * or expired. `offset`/`limit` are clamped, never rejected.
   */
  get(id: string, offset: number, limit: number): Promise<ResultSlice | null>;
}

/**
 * What `onBeforeDispatch` may return. `undefined` means "carry on"; `{ veto }`
 * stops the loop cleanly. Not exported: consumers satisfy it structurally, and
 * an exported-but-unreferenced type is what `pnpm knip` flags.
 */
type BeforeDispatchResult = { veto: { reason: string } } | undefined;

export interface AgentLoopOptions {
  model: AgentModel;
  /**
   * Ordered backup models tried after the primary exhausts per-model retries on a
   * transient failure. Cap is primary + 3 (see MAX_FAILOVER_CANDIDATES). Same
   * provider/adapter path as the primary — not cross-provider.
   */
  fallbackModels?: AgentModel[];
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  /**
   * Max model dispatches. `null` means unlimited — in that case the wall-clock
   * deadline (and the loop guard) are the only termination backstops, so callers
   * that pass `null` should pass a `timeoutMs`/`deadlineAt` too.
   */
  maxIterations: number | null;
  /**
   * Ceiling on tokens the model may emit per turn, forwarded to the provider.
   * Defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS}; pass `null` to fall back to the
   * provider default (not recommended — see the constant's comment).
   */
  maxOutputTokens?: number | null;
  /**
   * Wall-clock budget for the whole loop in ms, measured from loop start.
   * `undefined`/`null` = no timeout. On expiry the loop aborts its in-flight
   * dispatch and resolves with `stopReason: "timeout"`.
   */
  timeoutMs?: number | null;
  /**
   * Absolute epoch-ms deadline, for a budget shared across several loops (e.g. one
   * per-run deadline enforced by every node). When both this and `timeoutMs` are
   * set, the earlier one wins. `undefined`/`null` = no deadline.
   */
  deadlineAt?: number | null;
  /**
   * Stable identifier for this request's cacheable prefix (system prompt + tool schemas).
   * Forwarded as the prompt-cache key: OpenRouter's `session_id` (keeps the session on one
   * provider) and, on the responses API, OpenAI's `prompt_cache_key`. Callers derive it
   * deterministically — e.g. `${runId}:${stepName}` for a multi-step run, the chat
   * `sessionId` for chat — so sibling requests share a key.
   */
  cacheKey?: string;
  /** Prompt caching is enabled by default; pass `false` as a debug off-switch. */
  cache?: boolean;
  /**
   * Optional transient store for tool results that overflow `maxResultChars`.
   * When present, an oversized result is stored verbatim and replaced with a
   * bounded head + marker, and `retrieve_tool_result` is auto-registered so the
   * agent can page the tail. When absent, results are hard-truncated as before.
   */
  resultStore?: ResultStore;
  abortSignal?: AbortSignal;
  /**
   * Max consecutive identical tool executions (same name + canonicalized args)
   * before the loop guard synthesizes an error result instead of re-running the
   * tool. Default 2 (the third back-to-back identical call is blocked).
   */
  loopGuardThreshold?: number;
  /**
   * Invoked immediately before every model dispatch (including the first and
   * retry/failover re-dispatches). May mutate tool-result body text in place
   * (pairing invariant). Returning `{ veto }` stops the loop cleanly.
   *
   * A hook that has nothing to say must return `undefined` explicitly rather
   * than falling off the end — the return type is deliberately not `void`, so
   * that `{ veto }` can share the union without it.
   */
  onBeforeDispatch?: (ctx: {
    messages: AgentMessage[];
    iteration: number;
    lastDispatchAt: number | null;
  }) => BeforeDispatchResult | Promise<BeforeDispatchResult>;
  /** Context prune configuration (cache-cold / token-threshold offload). */
  prune?: {
    enabled?: boolean;
    cacheTtlMs?: number;
    tokenThreshold?: number;
  };
  onPruneStats?: (stats: {
    prunedBodies: number;
    prunedChars: number;
    elidedDuplicates: number;
    skippedStoreFailures: number;
    ran: boolean;
    reason: string;
  }) => void | Promise<void>;
  /**
   * Steering seam. Called right before every model dispatch (the first included);
   * the returned messages are appended to the conversation as user turns, announced
   * through `onTurn`, and read by the model at that dispatch. Return `[]` when there
   * is nothing to add.
   *
   * - **Never duplicated.** A message whose `id` is already in the conversation, or
   *   was delivered earlier in this loop, is dropped; so is any message whose role
   *   is not `"user"`. The hook should still hand each message over once (drain a
   *   queue), but a repeat is harmless.
   * - **Late steers.** When the model finishes a turn without requesting tools, the
   *   loop asks once more; if messages arrive (and the iteration budget, deadline and
   *   abort signal allow another dispatch) it appends them and dispatches again
   *   instead of stopping, so a steer accepted during the final dispatch is not lost.
   * - Synchronous on purpose: the host keeps the queue in memory. A throwing hook is
   *   logged and treated as `[]`.
   */
  takeSteeringMessages?: () => AgentMessage[];
  onMessagesChange?: (messages: AgentMessage[]) => void | Promise<void>;
  /**
   * Notified once for every message that becomes part of the conversation — the
   * seed messages, then each completed assistant turn and each tool-result message —
   * in append order, as it happens. This is the observability seam: the caller can
   * persist/publish a turn while the loop is still running instead of waiting for
   * {@link AgentLoopResult}.
   *
   * SEQ INVARIANT: `seq` is a 0-based running counter over turns **in the order they
   * were appended**, never an index into the current message array. The pre-dispatch
   * prune pass rewrites message bodies in place and the stream processor hands back a
   * freshly built array on every dispatch, so a positional scheme would silently
   * renumber history. Messages are tracked by identity, so each is announced exactly
   * once no matter how often the array is rebuilt.
   *
   * DELIVERY: fired only after a dispatch has completed successfully, so a mid-stream
   * failure that the retry/failover adapter swallows never leaks partial assistant
   * text through this hook. Awaited in order — a slow hook backpressures the loop
   * rather than reordering turns.
   *
   * FAILURE: a throwing or rejecting hook is caught and logged, never propagated.
   * Observability must not be able to fail an agent run.
   */
  onTurn?: (turn: {
    seq: number;
    /** `"system" | "user" | "assistant"`, or `"tool"` for a pure tool-result message. */
    role: string;
    message: AgentMessage;
  }) => void | Promise<void>;
  onChunk?: (chunk: unknown) => void | Promise<void>;
  onUsage?: (usage: AgentUsage) => void | Promise<void>;
}

/**
 * Why the loop stopped. Exhaustive — callers must handle every member.
 *
 * - `completed` — the model finished its turn naturally. The only clean success.
 * - `max-iterations` — the iteration budget ran out mid-work. Incomplete.
 * - `output-truncated` — the model's output hit the token ceiling, so its final
 *   message (very plausibly a long tool call) was cut off. Incomplete, and the work
 *   it was describing may have been silently dropped. Never treat as success.
 * - `timeout` — the wall-clock deadline elapsed. Incomplete.
 * - `aborted` — the caller's `abortSignal` fired (run cancelled).
 * - `vetoed` — `onBeforeDispatch` stopped the loop (budget, run no longer active).
 */
export type AgentStopReason =
  | "completed"
  | "max-iterations"
  | "output-truncated"
  | "timeout"
  | "aborted"
  | "vetoed";

export interface AgentLoopResult {
  messages: AgentMessage[];
  usage: AgentUsage;
  stopReason: AgentStopReason;
  /** Present when stopReason is "vetoed". */
  vetoReason?: string;
  /**
   * Raw provider finish reason for the final turn, when one was reported. Present for
   * diagnostics on any completed dispatch; most useful alongside `"output-truncated"`,
   * where it records the exact spelling the provider used (`length`, `MAX_TOKENS`, …).
   */
  finishReason?: string;
}
