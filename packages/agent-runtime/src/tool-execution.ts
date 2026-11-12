import type { AgentTool } from "./types";

/**
 * Running one tool call under the run's abort signal.
 *
 * WHY THIS EXISTS: `maxIterations` counts *finished* dispatches, so the
 * wall-clock deadline is the only backstop against work that never finishes —
 * and it was not covering the tool seam. A tool whose promise never settles (a
 * stalled fetch with no timeout is the everyday case) parked the loop inside
 * `await tool.execute(input)` forever. The deadline timer fired, aborted the
 * controller, and nothing was listening: the loop never returned, so
 * `CHAT_RUN_TIMEOUT_MS` — advertised as a wall-clock bound — silently did not
 * apply. Downstream of that, in the chat consumer, the BullMQ job stayed
 * `active`, the stale-run reaper deliberately treats an `active` job as live and
 * skips it, the session stayed RUNNING forever, and a worker slot was consumed
 * permanently.
 *
 * TWO HALVES, AND BOTH ARE REQUIRED:
 *
 * 1. **Cancellation reaches the tool.** `execute` receives the run's
 *    `AbortSignal` as a second argument, so a well-behaved tool can pass it to
 *    `fetch`, a database driver, or a child process and actually stop working.
 *    Abandoning a tool without telling it only stops the *loop* from waiting;
 *    the work keeps burning the process it runs in.
 * 2. **The loop stops waiting regardless.** A tool that ignores the signal —
 *    every tool written before this argument existed — must not be able to hold
 *    the run open. So execution is raced against the signal, and the loser is
 *    abandoned.
 *
 * ABANDONED MEANS ABANDONED. A tool that settles after the race is over must
 * not be able to touch anything: its value is never serialized (so it is never
 * written to the `ResultStore`), never returned to the model, and never
 * announced as a turn; its rejection is swallowed here rather than surfacing as
 * an unhandled rejection or, worse, as a `FatalToolError` aborting a *later*
 * run that reuses the process. The loop has moved on, and a message written or
 * an index advanced behind its back is exactly the corruption the deadline
 * exists to prevent.
 */

/**
 * Failure raised when a tool is abandoned because the run's signal fired.
 *
 * `name` is `"AbortError"` deliberately: callers classify aborts by that name,
 * and the loop's own deadline bookkeeping then reports the run as
 * `stopReason: "timeout"` (a deadline abort) or `"aborted"` (a caller cancel) —
 * the existing stop reasons, so no caller needs new handling.
 */
export class ToolAbandonedError extends Error {
  override readonly name = "AbortError";
  constructor(toolName: string, reason: unknown) {
    super(`Tool "${toolName}" was abandoned: the run's deadline elapsed or it was aborted.`);
    this.cause = reason;
  }
}

/**
 * Execute one tool call, racing it against `signal`.
 *
 * Resolves with the tool's value, rejects with the tool's own error, or rejects
 * with {@link ToolAbandonedError} when the signal fires first — whichever
 * happens first, and never more than once.
 */
export const executeToolWithAbort = async (
  tool: Pick<AgentTool, "name" | "execute">,
  input: Parameters<AgentTool["execute"]>[0],
  signal: AbortSignal,
): Promise<unknown> => {
  if (signal.aborted) throw new ToolAbandonedError(tool.name, signal.reason);

  // Wrapped in a promise so a tool that throws synchronously is a rejection
  // like any other, rather than escaping the race entirely.
  const execution = Promise.resolve().then(() => tool.execute(input, signal));
  // The abandoned branch is not an error anyone is waiting for. Attach the sink
  // eagerly: without it, a tool that rejects after the race would surface as an
  // unhandled rejection and, in a worker, take the process down.
  execution.catch(() => {});

  let settled = false;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new ToolAbandonedError(tool.name, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      execution.then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    // A long run makes thousands of tool calls against one signal; a listener
    // left behind per call is a leak, not a detail.
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};
