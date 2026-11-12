import { isDeadlineAbort } from "./deadline";
import { AgentRuntimeError, FatalToolError } from "./errors";
import { executeTanstackLoop } from "./tanstack-loop";
import type { AgentLoopOptions, AgentLoopResult, AgentStopReason } from "./types";

const emptyResult = (
  options: AgentLoopOptions,
  stopReason: Extract<AgentStopReason, "aborted" | "vetoed" | "timeout">,
  vetoReason?: string,
): AgentLoopResult => ({
  messages: options.messages,
  usage: { inputTokens: 0, outputTokens: 0 },
  stopReason,
  ...(vetoReason !== undefined ? { vetoReason } : {}),
});

const getStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
};

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const toRuntimeError = (error: unknown): AgentRuntimeError => {
  const status = getStatus(error);
  const retryable =
    status === 429 || (status !== undefined && status >= 500) || status === undefined;
  const message = error instanceof Error ? error.message : "Agent model request failed";
  return new AgentRuntimeError(message, { retryable, status, cause: error });
};

export const runAgentLoop = async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
  if (options.abortSignal?.aborted) return emptyResult(options, "aborted");

  const abortController = new AbortController();
  const abort = () => abortController.abort(options.abortSignal?.reason);
  options.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    const result = await executeTanstackLoop(options, abortController);
    if (result.vetoed) {
      return {
        messages: result.messages,
        usage: result.usage,
        stopReason: "vetoed",
        vetoReason: result.vetoReason,
      };
    }
    // Precedence: a wall-clock stop and a truncated final turn are both more
    // actionable than "ran out of iterations", and none of the three is a success.
    const stopReason: AgentStopReason = result.timedOut
      ? "timeout"
      : result.outputTruncated
        ? "output-truncated"
        : result.hitIterationLimit
          ? "max-iterations"
          : "completed";
    return {
      messages: result.messages,
      usage: result.usage,
      stopReason,
      ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
    };
  } catch (error) {
    if (error instanceof FatalToolError) throw error;
    // A deadline abort must not be reported as a caller-requested cancel: the run was
    // not cancelled, it ran out of wall-clock time with work still outstanding.
    if (abortController.signal.aborted && isDeadlineAbort(abortController.signal.reason))
      return emptyResult(options, "timeout");
    if (abortController.signal.aborted || isAbortError(error))
      return emptyResult(options, "aborted");
    if (error instanceof AgentRuntimeError) throw error;
    throw toRuntimeError(error);
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
  }
};
