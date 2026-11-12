import { randomUUID } from "node:crypto";

import {
  chat,
  convertMessagesToModelMessages,
  fromSpecTokenUsage,
  maxIterations,
  type StreamChunk,
  StreamProcessor,
  toolDefinition,
  type UIMessage,
} from "@tanstack/ai";

import { createModelAdapter, resolveMaxOutputTokens, resolvePromptCache } from "./adapters";
import { pruneAgentMessages } from "./context-prune";
import { isDeadlineAbort, startDeadline } from "./deadline";
import { errorFromRunErrorChunk, FatalToolError } from "./errors";
import { isTruncatedFinish, normalizeFinishReason } from "./finish-reason";
import { LoopGuard } from "./loop-guard";
import { createUsageTap } from "./raw-usage";
import { MAX_FAILOVER_CANDIDATES } from "./retry";
import { createRetryFailoverAdapter } from "./retry-adapter";
import { executeToolWithAbort } from "./tool-execution";
import { buildRetrieveToolResultTool, serializeToolResultWithStore } from "./tools";
import type { AgentLoopOptions, AgentMessage, AgentMessagePart, AgentUsage } from "./types";

export interface TanstackLoopResult {
  messages: AgentMessage[];
  usage: AgentUsage;
  hitIterationLimit: boolean;
  /**
   * The model's output hit the token ceiling (any provider spelling of `length`), so its
   * final message — plausibly a long tool call — was cut off mid-stream. Never a clean
   * finish; see the `"output-truncated"` stop reason.
   */
  outputTruncated?: boolean;
  /** Raw provider finish reason of the last completed dispatch, when reported. */
  finishReason?: string;
  /** The wall-clock deadline elapsed. */
  timedOut?: boolean;
  vetoed?: boolean;
  vetoReason?: string;
}

const toUIMessage = (message: AgentMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts as UIMessage["parts"],
  createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
});

/** Read the first present, finite numeric field from a raw usage object; else undefined. */
const numericField = (source: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

// AG-UI `activity` messages are frontend-only render state — never model input or a
// stored turn — so they are dropped rather than widening `AgentMessage.role`.
//
// `cache` is keyed by UIMessage IDENTITY. TanStack's StreamProcessor emits a fresh
// array on every streamed chunk, but its message updaters return an untouched
// message object as-is (`if (msg.id !== messageId) return msg`) and rebuild the one
// they change, so a hit is always a message whose content has not changed since it
// was converted. Without it every text/tool-args chunk re-converted the whole
// conversation.
const fromUIMessages = (
  messages: UIMessage[],
  cache?: WeakMap<UIMessage, AgentMessage>,
): AgentMessage[] =>
  messages.flatMap((message) => {
    if (message.role === "activity") return [];
    const cached = cache?.get(message);
    if (cached) return [cached];
    const converted: AgentMessage = {
      id: message.id,
      role: message.role,
      parts: message.parts as unknown as AgentMessagePart[],
      createdAt: message.createdAt?.toISOString(),
    };
    cache?.set(message, converted);
    return [converted];
  });

/**
 * Storage role for one turn. `AgentMessage.role` has no `"tool"` member — a tool
 * result arrives as a message whose parts are all `tool-result` — so it is derived
 * here rather than invented at each call site.
 */
const turnRole = (message: AgentMessage): string =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "tool-result")
    ? "tool"
    : message.role;

export const executeTanstackLoop = async (
  options: AgentLoopOptions,
  abortController: AbortController,
): Promise<TanstackLoopResult> => {
  let currentMessages: AgentMessage[] = options.messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => ({ ...p })),
  }));
  let callbackQueue = Promise.resolve();
  let fatalError: FatalToolError | undefined;
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  let runCount = 0;
  let finalFinishReason: string | null = null;
  let outputTruncated = false;
  let lastDispatchAt: number | null = null;
  // `null` maxIterations = unlimited; the deadline and the loop guard are then the
  // only backstops (see AgentLoopOptions.maxIterations).
  const iterationCap =
    options.maxIterations === null ? Number.POSITIVE_INFINITY : options.maxIterations;

  // When a store is injected, register `retrieve_tool_result` so the agent can page
  // any body that overflowed a tool's cap.
  const runtimeTools = options.resultStore
    ? [...options.tools, buildRetrieveToolResultTool(options.resultStore)]
    : options.tools;

  // Back-to-back identical tool calls waste iterations; the guard synthesizes a
  // stable error result instead of re-executing. Even tools whose results could
  // change from *sibling* agents cannot observe new writes from *this* agent
  // without an intervening call — so consecutive identical calls are safe to block.
  // ── Per-turn observability ────────────────────────────────────────────────────
  // `seq` is the APPEND ORDER of turns, not a position in `currentMessages`. Two
  // things make a positional scheme wrong: the pre-dispatch prune pass rewrites
  // message bodies in place (and may in future compact them), and the stream
  // processor returns a freshly constructed array on every dispatch. Tracking which
  // messages have already been announced by IDENTITY keeps `seq` stable and monotonic
  // across both. The counter only ever moves forward.
  let nextTurnSeq = 0;
  const announcedTurns = new Set<string>();
  const turnKey = (message: AgentMessage, index: number): string =>
    message.id ? `id:${message.id}` : `pos:${index}:${message.role}`;

  /**
   * Announce every message not yet seen, in array order. Never throws: an
   * observability hook must not be able to fail the agent loop.
   */
  const announceTurns = async (messages: AgentMessage[]): Promise<void> => {
    const onTurn = options.onTurn;
    if (!onTurn) return;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const key = turnKey(message, index);
      if (announcedTurns.has(key)) continue;
      announcedTurns.add(key);
      const seq = nextTurnSeq;
      nextTurnSeq += 1;
      try {
        await onTurn({ seq, role: turnRole(message), message });
      } catch (error) {
        console.warn(`[agent-runtime] onTurn hook failed at seq=${seq}`, error);
      }
    }
  };

  // ── Steering ─────────────────────────────────────────────────────────────────
  // `takeSteeringMessages` hands over user messages the host queued while the loop
  // was running. Each is appended exactly once: ids already in the conversation or
  // delivered earlier are dropped, so a host that hands the same message back twice
  // (or a retry of a dispatch) can never duplicate it.
  const deliveredSteeringIds = new Set<string>();
  const takeSteering = (): AgentMessage[] => {
    const take = options.takeSteeringMessages;
    if (!take) return [];
    let taken: AgentMessage[];
    try {
      taken = take() ?? [];
    } catch (error) {
      console.warn("[agent-runtime] takeSteeringMessages hook failed", error);
      return [];
    }
    const present = new Set(currentMessages.map((message) => message.id));
    const fresh: AgentMessage[] = [];
    for (const message of taken) {
      if (message?.role !== "user") {
        console.warn("[agent-runtime] ignored a steering message that is not a user message");
        continue;
      }
      if (present.has(message.id) || deliveredSteeringIds.has(message.id)) continue;
      present.add(message.id);
      deliveredSteeringIds.add(message.id);
      fresh.push({ ...message, parts: message.parts.map((part) => ({ ...part })) });
    }
    return fresh;
  };
  /** Steering taken after a final turn, carried into the extra dispatch it causes. */
  let carriedSteering: AgentMessage[] = [];

  const loopGuard = new LoopGuard(options.loopGuardThreshold);
  const allToolNames = runtimeTools.map((tool) => tool.name);

  const tools = runtimeTools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).server(async (input) => {
      const guarded = loopGuard.check(tool.name, input, allToolNames);
      if (guarded !== null) {
        return guarded;
      }
      try {
        // Raced against the run's abort signal, which the deadline fires. A
        // tool that never settles would otherwise hold the loop open forever
        // and the wall-clock bound would not exist — see tool-execution.ts.
        // Nothing below this line runs for an abandoned call, so a late result
        // can never be stored, returned, or announced.
        const output = await executeToolWithAbort(tool, input, abortController.signal);
        return await serializeToolResultWithStore(output, tool.maxResultChars, {
          store: options.resultStore,
          untrusted: tool.untrusted,
        });
      } catch (error) {
        if (error instanceof FatalToolError) {
          fatalError = error;
          abortController.abort(error);
        }
        throw error;
      }
    }),
  );

  const cacheOpts = {
    enabled: options.cache !== false,
    cacheKey: options.cacheKey,
  };
  const promptCache = resolvePromptCache(cacheOpts);
  // TanStack AI 1.0 requires a thread id on every chat() call. One loop is one thread:
  // nothing here resumes or persists through TanStack, so it only labels the run's events.
  const threadId = randomUUID();
  const modelCandidates = [options.model, ...(options.fallbackModels ?? [])].slice(
    0,
    MAX_FAILOVER_CANDIDATES,
  );
  const { adapter, modelOptions, getServingModelId } = createRetryFailoverAdapter({
    candidates: modelCandidates.map((model) => {
      const bundle = createModelAdapter(model, cacheOpts);
      return {
        ...bundle,
        modelId: model.model,
        ...(model.stallTimeoutMs !== undefined ? { stallTimeoutMs: model.stallTimeoutMs } : {}),
      };
    }),
    abortSignal: abortController.signal,
    onFailover: (serving, primary) => {
      console.warn(`[agent-runtime] model failover: primary=${primary} serving=${serving}`);
    },
  });

  // Wall-clock backstop. Expiry aborts the same controller the dispatch already uses,
  // so an in-flight stream is cut off instead of running to completion.
  const deadline = startDeadline(options, abortController);
  let timedOut = false;

  // Explicit output ceiling — never rely on the provider default (see
  // DEFAULT_MAX_OUTPUT_TOKENS: a low default truncates long tool calls).
  const maxOutputTokens = resolveMaxOutputTokens(options.maxOutputTokens);

  try {
    // The seed messages are turns too: without them the persisted history opens
    // mid-conversation, with no record of the prompt the node was actually given.
    await announceTurns(currentMessages);

    // Harness-driven iterations so we own the message array between dispatches
    // (onBeforeDispatch + prune seam). Each chat() call runs a single model turn.
    for (let iteration = 0; iteration < iterationCap; iteration += 1) {
      if (deadline.expired()) {
        timedOut = true;
        break;
      }
      if (abortController.signal.aborted) {
        if (isDeadlineAbort(abortController.signal.reason)) timedOut = true;
        break;
      }

      // Steering lands right before the dispatch, so the model reads it at its next
      // step. The messages are announced at once: they are turns like any other.
      const steering = carriedSteering.length > 0 ? carriedSteering : takeSteering();
      carriedSteering = [];
      if (steering.length > 0) {
        currentMessages = [...currentMessages, ...steering];
        await announceTurns(currentMessages);
      }

      // Built-in prune pass (first registered use of the pre-dispatch seam).
      if (options.prune?.enabled !== false && options.resultStore) {
        const pruneStats = await pruneAgentMessages(currentMessages, options.resultStore, {
          enabled: options.prune?.enabled,
          cacheTtlMs: options.prune?.cacheTtlMs,
          tokenThreshold: options.prune?.tokenThreshold,
          lastDispatchAt,
        });
        if (pruneStats.ran) {
          await options.onPruneStats?.(pruneStats);
        }
      }

      const hookResult = await options.onBeforeDispatch?.({
        messages: currentMessages,
        iteration,
        lastDispatchAt,
      });
      if (hookResult && typeof hookResult === "object" && "veto" in hookResult) {
        await callbackQueue;
        return {
          messages: currentMessages,
          usage,
          hitIterationLimit: false,
          vetoed: true,
          vetoReason: hookResult.veto.reason,
        };
      }

      lastDispatchAt = Date.now();
      const uiMessages = currentMessages.map(toUIMessage);
      // Per dispatch: the processor's message objects live only as long as it does.
      const emittedMessages = new WeakMap<UIMessage, AgentMessage>();
      const processor = new StreamProcessor({
        initialMessages: uiMessages,
        events: {
          // Only the hook reads these arrays: `currentMessages` is rebuilt from the
          // processor once `process()` returns, and a throw leaves the loop, so with
          // no hook there is nothing to convert.
          onMessagesChange: (messages) => {
            if (!options.onMessagesChange) return;
            const serializable = fromUIMessages(messages, emittedMessages);
            callbackQueue = callbackQueue.then(() => options.onMessagesChange?.(serializable));
            // Mark the tail handled at once. Awaiting it below still rethrows a hook
            // failure; without this, a rejection that nothing awaits before the next
            // macrotask (a dispatch still streaming, or any throw out of the loop) is an
            // unhandled rejection, which ends the process.
            callbackQueue.catch(() => {});
          },
        },
      });

      // Reads the wire usage alongside the adapter, for the fields it drops (raw-usage.ts).
      const usageTap = createUsageTap();
      const stream = chat({
        adapter,
        messages: convertMessagesToModelMessages(uiMessages),
        systemPrompts: [options.systemPrompt],
        tools,
        abortController,
        agentLoopStrategy: maxIterations(1),
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
        threadId,
        promptCache,
        wrapFetch: usageTap.wrap,
      });

      async function* observe(): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
          // A failed dispatch arrives as a chunk, not a throw (see errorFromRunErrorChunk).
          // Without this the loop would end as `completed` with no answer.
          if (chunk.type === "RUN_ERROR") throw errorFromRunErrorChunk(chunk);
          await options.onChunk?.(chunk);
          if (chunk.type === "RUN_FINISHED") {
            runCount += 1;
            finalFinishReason =
              chunk.finishReason ?? chunk.metadata?.tanstack?.finishReason ?? null;
            // Any provider spelling of "hit the output ceiling" — the chunk's own field,
            // a passed-through native reason, or an incomplete-details reason.
            if (isTruncatedFinish(chunk) || isTruncatedFinish(chunk.metadata?.tanstack)) {
              outputTruncated = true;
            }
            // AG-UI reports an array; the public normalizer also restores cache details
            // from TanStack metadata. Older adapters still report the legacy object.
            const tokenUsage = Array.isArray(chunk.usage)
              ? fromSpecTokenUsage(chunk.usage, chunk.metadata?.tanstack?.usage)
              : chunk.usage;
            if (tokenUsage) {
              const turnUsage: AgentUsage = {
                inputTokens: tokenUsage.promptTokens,
                outputTokens: tokenUsage.completionTokens,
                model: getServingModelId(),
              };
              const rawUsage = tokenUsage as unknown as Record<string, unknown>;
              const cachedInputTokens =
                tokenUsage.promptTokensDetails?.cachedTokens ??
                numericField(rawUsage, ["cachedTokens", "cached_tokens"]);
              const wire = usageTap.latest();
              const cacheCreationInputTokens =
                tokenUsage.promptTokensDetails?.cacheWriteTokens ??
                numericField(rawUsage, [
                  "cacheCreationTokens",
                  "cache_creation_input_tokens",
                  "cacheCreationInputTokens",
                ]) ??
                wire?.cacheWriteTokens;
              if (cachedInputTokens !== undefined) {
                turnUsage.cachedInputTokens = cachedInputTokens;
                usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cachedInputTokens;
              }
              // OpenRouter reports the dispatch's billed cost in USD as `usage.cost`.
              const costUsd = numericField(rawUsage, ["cost"]) ?? wire?.costUsd;
              if (costUsd !== undefined) {
                turnUsage.costUsd = costUsd;
                usage.costUsd = (usage.costUsd ?? 0) + costUsd;
              }
              if (cacheCreationInputTokens !== undefined) {
                turnUsage.cacheCreationInputTokens = cacheCreationInputTokens;
                usage.cacheCreationInputTokens =
                  (usage.cacheCreationInputTokens ?? 0) + cacheCreationInputTokens;
              }
              usage.inputTokens += turnUsage.inputTokens;
              usage.outputTokens += turnUsage.outputTokens;
              if (usage.model === undefined) usage.model = turnUsage.model;
              await options.onUsage?.(turnUsage);
            }
          }
          yield chunk;
        }
      }

      try {
        await processor.process(observe());
      } catch (error) {
        if (fatalError) throw fatalError;
        throw error;
      }
      if (fatalError) throw fatalError;

      currentMessages = fromUIMessages(processor.getMessages());

      // Only now — the dispatch completed. The retry/failover adapter buffers a whole
      // attempt before yielding, so a mid-stream failure never reaches here and partial
      // assistant text is never announced as a turn. A truncated-but-finished turn IS
      // announced (it is real output, and the stop reason says it was cut off).
      await announceTurns(currentMessages);

      // A truncated turn is never a reason to dispatch again: whatever the model was
      // emitting (very plausibly a long tool call) is incomplete, and the caller must be
      // told rather than shown a clean-looking stop.
      if (outputTruncated) break;

      // Continue only when the model requested more tools — or when a steer arrived
      // while the model was writing what would have been its final turn: dropping it
      // would lose an instruction the host already accepted.
      if (normalizeFinishReason(finalFinishReason) !== "tool-calls") {
        const canDispatchAgain =
          iteration + 1 < iterationCap && !deadline.expired() && !abortController.signal.aborted;
        if (canDispatchAgain) carriedSteering = takeSteering();
        if (carriedSteering.length === 0) break;
      }
    }

    await callbackQueue;
    if (fatalError) throw fatalError;

    return {
      messages: currentMessages,
      usage,
      hitIterationLimit:
        !outputTruncated &&
        !timedOut &&
        runCount >= iterationCap &&
        normalizeFinishReason(finalFinishReason) === "tool-calls",
      ...(outputTruncated ? { outputTruncated: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(finalFinishReason !== null ? { finishReason: finalFinishReason } : {}),
    };
  } finally {
    deadline.cancel();
  }
};
