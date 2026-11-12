import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { executeToolWithAbort, ToolAbandonedError } from "./tool-execution";
import type { AgentTool } from "./types";

const tool = (execute: AgentTool["execute"]): Pick<AgentTool, "name" | "execute"> => ({
  name: "hang",
  execute,
});

/** A promise the test controls, standing in for a fetch with no timeout. */
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("executeToolWithAbort", () => {
  it("passes the run's signal to the tool so it can stop its own work", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    await executeToolWithAbort(
      tool((_input, signal) => {
        received = signal;
        return "ok";
      }),
      {},
      controller.signal,
    );
    expect(received).toBe(controller.signal);
  });

  it("keeps working for a one-argument tool", async () => {
    // Backward compatibility is the whole reason the signal is a second
    // argument: every tool written before it exists must still be assignable.
    const legacy = { name: "legacy", execute: () => 42 };
    await expect(executeToolWithAbort(legacy, {}, new AbortController().signal)).resolves.toBe(42);
  });

  it("surfaces the tool's own error unchanged", async () => {
    await expect(
      executeToolWithAbort(
        tool(() => {
          throw new Error("file not found");
        }),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("file not found");
  });

  it("stops waiting for a tool that never settles once the signal fires", async () => {
    const controller = new AbortController();
    const hung = deferred();
    const running = executeToolWithAbort(
      tool(() => hung.promise),
      {},
      controller.signal,
    );
    controller.abort("agent-runtime:wall-clock-deadline-exceeded");
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolAbandonedError);
    // Classified as an abort by name, which is what routes the run to the
    // EXISTING timeout/aborted stop reasons instead of a new failure mode.
    expect((error as Error).name).toBe("AbortError");
    expect((error as Error).cause).toBe("agent-runtime:wall-clock-deadline-exceeded");
  });

  it("refuses to start a tool when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    await expect(executeToolWithAbort(tool(execute), {}, controller.signal)).rejects.toBeInstanceOf(
      ToolAbandonedError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("discards a value that arrives after the tool was abandoned", async () => {
    const controller = new AbortController();
    const hung = deferred();
    const running = executeToolWithAbort(
      tool(() => hung.promise),
      {},
      controller.signal,
    );
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(ToolAbandonedError);
    // The abandoned call settles late. It must not be able to change what the
    // caller saw — the loop has already moved on, and a result that turned up
    // here would be serialized into the transcript out of order.
    hung.resolve("too late");
    await expect(running).rejects.toBeInstanceOf(ToolAbandonedError);
  });

  it("swallows a rejection that arrives after the tool was abandoned", async () => {
    const controller = new AbortController();
    const hung = deferred();
    const running = executeToolWithAbort(
      tool(() => hung.promise),
      {},
      controller.signal,
    );
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(ToolAbandonedError);
    hung.reject(new Error("late failure"));
    // No unhandled rejection: an eager sink is attached to the execution, so a
    // late failure cannot take a worker process down long after the run ended.
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });

  it("does not leave an abort listener behind per call", async () => {
    // A long run makes thousands of tool calls against one signal.
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await executeToolWithAbort(
      tool(() => "ok"),
      {},
      controller.signal,
    );
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts a Zod-typed tool without widening its input", () => {
    // Type-level guard: `defineTool`'s ergonomics must survive the new argument.
    const typed: AgentTool<z.ZodObject<{ city: z.ZodString }>> = {
      name: "weather",
      description: "",
      inputSchema: z.object({ city: z.string() }),
      maxResultChars: 100,
      execute: ({ city }) => city.toUpperCase(),
    };
    expect(typed.name).toBe("weather");
  });
});
