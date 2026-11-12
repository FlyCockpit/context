import path from "node:path";

import type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentMessage,
  AgentUsage,
} from "@cockpit-context/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoop = vi.fn<(options: AgentLoopOptions) => Promise<AgentLoopResult>>();

vi.mock("@cockpit-context/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("@cockpit-context/agent-runtime")>(
    "@cockpit-context/agent-runtime",
  );
  return { ...actual, runAgentLoop };
});

const {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RUN_TIMEOUT_MS,
  deriveExploreBudgets,
  ExploreAgentError,
  exploreAgentAnswer,
  FORCE_FINAL_MESSAGE_ID,
  runExploreAgent,
} = await import("./run-explore-agent");
const { EXAMPLES_FIRST_PROMPT, MASTER_DELEGATE_PROMPT } = await import("./prompts");

const ROOT = path.resolve(import.meta.dirname, "../fixtures/sample-pkg");

type LoopOptions = AgentLoopOptions;

const assistant = (id: string, content: string): AgentMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", content }],
});

const completed = (
  messages: AgentMessage[],
  usage: AgentUsage = { inputTokens: 1, outputTokens: 1 },
): AgentLoopResult => ({ stopReason: "completed", messages, usage });

/** Behave like the runtime's observability: seeds, then each new turn, then usage. */
async function announce(options: AgentLoopOptions, added: AgentMessage[], usage?: AgentUsage) {
  let seq = 0;
  for (const message of [...options.messages, ...added]) {
    await options.onTurn?.({ seq: seq++, role: message.role, message });
  }
  if (usage) await options.onUsage?.(usage);
}

const isSynthesis = (options: AgentLoopOptions) => options.tools.length === 0;
const isHelper = (options: AgentLoopOptions) =>
  options.messages[0]?.id.startsWith("explore-helper-") === true;

const base = {
  root: ROOT,
  apiKey: "test-key",
  model: "vendor/main-model",
  ripgrep: false as const,
};

describe("runExploreAgent", () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
    runAgentLoop.mockResolvedValue(
      completed([assistant("a1", "Call `greet(name)` — src/greet.ts:2")]),
    );
  });

  it("dispatches a confined explore loop with the configured OpenRouter model", async () => {
    const result = await runExploreAgent({
      ...base,
      baseUrl: "http://localhost:4010/api/v1",
      question: "  How do I greet someone?  ",
      package: { identifier: "npm:sample-pkg", versionOrRef: "1.0.0" },
      userNotes: "tiny greeting package",
      repoMap: false,
      examplesFirst: false,
      allowDelegation: false,
      forceFinalAnswer: false,
    });

    expect(runAgentLoop).toHaveBeenCalledOnce();
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.model).toEqual({
      api: "chat-completions",
      model: "vendor/main-model",
      apiKey: "test-key",
      baseUrl: "http://localhost:4010/api/v1",
    });
    expect(options.messages).toHaveLength(1);
    expect(options.messages[0]?.parts[0]).toMatchObject({ content: "How do I greet someone?" });
    expect(options.systemPrompt).toContain("- Package: npm:sample-pkg");
    expect(options.systemPrompt).toContain("tiny greeting package");
    expect(options.systemPrompt).not.toContain("Repo map");
    expect(options.tools.map((tool) => tool.name)).toEqual(["glob", "grep", "read"]);
    expect(result.answer).toContain("greet(name)");
    expect(exploreAgentAnswer(result)).toContain("greet(name)");
    expect(result.model).toBe("vendor/main-model");
  });

  it("speaks the configured model API", async () => {
    await runExploreAgent({ ...base, api: "messages", question: "q", repoMap: false });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.model.api).toBe("messages");
  });

  it("defaults to map + examples-first + delegate guidance and the env-default budgets", async () => {
    const result = await runExploreAgent({ ...base, question: "q", forceFinalAnswer: false });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.systemPrompt).toContain("Repo map");
    expect(options.systemPrompt).toContain(EXAMPLES_FIRST_PROMPT);
    expect(options.systemPrompt).toContain(MASTER_DELEGATE_PROMPT);
    expect(options.systemPrompt).toContain("<<<UNTRUSTED_WEB_CONTENT_START>>>");
    expect(options.tools.some((tool) => tool.name === "delegate_explore")).toBe(true);
    expect(options.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(options.timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(result.map?.rootName).toBe("sample-pkg");
  });

  it("registers extra tools for the master (the LSP seam)", async () => {
    const { defineTool } = await import("@cockpit-context/agent-runtime");
    const { z } = await import("zod");
    const extra = defineTool({
      name: "lsp_hover",
      description: "hover",
      inputSchema: z.object({}),
      untrusted: true,
      execute: () => "",
    });
    await runExploreAgent({ ...base, question: "q", extraTools: [extra], repoMap: false });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.tools.map((tool) => tool.name)).toEqual([
      "glob",
      "grep",
      "read",
      "lsp_hover",
      "delegate_explore",
    ]);
  });

  it("registers the LSP tools for the checkout when an LSP manager is passed", async () => {
    const { LspManager } = await import("./lsp/manager");
    const { testSandbox } = await import("./lsp/test-support/fake-lsp");
    const manager = new LspManager({ sandbox: testSandbox() });
    await runExploreAgent({
      ...base,
      question: "q",
      lsp: { manager, checkoutId: "checkout-1" },
      repoMap: false,
    });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.tools.map((tool) => tool.name)).toEqual([
      "glob",
      "grep",
      "read",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_workspace_symbols",
      "lsp_document_symbols",
      "delegate_explore",
    ]);
    // Registration alone starts no server.
    expect(manager.running()).toEqual([]);

    runAgentLoop.mockClear();
    await runExploreAgent({
      ...base,
      question: "q",
      lsp: {
        manager: new LspManager({ maxServers: 0, sandbox: testSandbox() }),
        checkoutId: "checkout-1",
      },
      repoMap: false,
    });
    const disabled = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(disabled.tools.some((tool) => tool.name.startsWith("lsp_"))).toBe(false);
  });

  it("appends a follow-up question after the conversation history", async () => {
    const history: AgentMessage[] = [
      { id: "h1", role: "user", parts: [{ type: "text", content: "first" }] },
      assistant("h2", "first answer"),
    ];
    await runExploreAgent({ ...base, question: "and then?", history, repoMap: false });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    expect(options.messages.map((message) => message.id)).toEqual([
      "h1",
      "h2",
      expect.stringMatching(/^explore-user-/),
    ]);
  });

  it("never reuses a message id already in the history", async () => {
    const history: AgentMessage[] = [
      { id: "explore-user-3", role: "user", parts: [{ type: "text", content: "first" }] },
      assistant("h2", "first answer"),
    ];
    await runExploreAgent({ ...base, question: "and then?", history, repoMap: false });
    const options = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    const ids = options.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("force-final runs a no-tool synthesis after max-iterations and sums usage", async () => {
    runAgentLoop
      .mockResolvedValueOnce({
        stopReason: "max-iterations",
        messages: [assistant("a1", "Still looking at builders…")],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
      })
      .mockResolvedValueOnce(
        completed(
          [
            assistant("a1", "Still looking at builders…"),
            assistant("a2", "Use AgentBuilder::new(model).tool(t).build()"),
          ],
          { inputTokens: 3, outputTokens: 4, costUsd: 0.01 },
        ),
      );
    const onSynthesisStart = vi.fn();

    const result = await runExploreAgent({
      ...base,
      question: "how tools?",
      repoMap: false,
      onSynthesisStart,
    });

    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    expect(result.forcedFinal).toBe(true);
    expect(result.stopReason).toBe("max-iterations");
    expect(result.answer).toContain("AgentBuilder");
    expect(onSynthesisStart).toHaveBeenCalledOnce();
    const synth = runAgentLoop.mock.calls[1]?.[0] as LoopOptions;
    expect(synth.tools).toEqual([]);
    expect(synth.maxIterations).toBe(1);
    expect(synth.messages.at(-1)?.id).toBe(FORCE_FINAL_MESSAGE_ID);
    expect(synth.systemPrompt).toContain("You have no tools in this turn");
    expect(synth.systemPrompt).toContain("<<<UNTRUSTED_WEB_CONTENT_START>>>");
    expect(result.usage).toMatchObject({ inputTokens: 13, outputTokens: 9 });
    expect(result.usage.costUsd).toBeCloseTo(0.03);
    expect(result.ownUsage).toEqual(result.usage);
  });

  it("does not synthesize after a caller abort", async () => {
    runAgentLoop.mockResolvedValueOnce({
      stopReason: "aborted",
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const result = await runExploreAgent({ ...base, question: "q", repoMap: false });
    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(result.forcedFinal).toBe(false);
    expect(result.stopReason).toBe("aborted");
  });

  it("synthesizes from the relayed transcript and metered usage after a deadline abort", async () => {
    runAgentLoop.mockImplementationOnce(async (options) => {
      // Two dispatches complete and are announced, then the deadline aborts the
      // third mid-stream: the runtime returns only its seeds and zero usage.
      await announce(options, [assistant("a1", "found src/greet.ts")], {
        inputTokens: 7,
        outputTokens: 2,
        costUsd: 0.07,
      });
      await options.onUsage?.({ inputTokens: 3, outputTokens: 1, costUsd: 0.03 });
      return {
        stopReason: "timeout",
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    runAgentLoop.mockImplementationOnce(async (options) => {
      const answer = assistant("a2", "greet(name, shout?) — src/greet.ts:2");
      await announce(options, [answer], { inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
      return completed([...options.messages, answer]);
    });

    const result = await runExploreAgent({ ...base, question: "q", repoMap: false });
    const synth = runAgentLoop.mock.calls[1]?.[0] as LoopOptions;
    expect(synth.messages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^explore-user-/),
      "a1",
      FORCE_FINAL_MESSAGE_ID,
    ]);
    expect(result.stopReason).toBe("timeout");
    expect(result.iterations).toBe(3);
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.costUsd).toBeCloseTo(0.11);
  });

  it("relays master turns with one running seq and no repeats across the synthesis", async () => {
    runAgentLoop.mockImplementationOnce(async (options) => {
      const added = [assistant("a1", "partial")];
      await announce(options, added);
      return {
        stopReason: "max-iterations",
        messages: [...options.messages, ...added],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    runAgentLoop.mockImplementationOnce(async (options) => {
      const answer = assistant("a2", "final");
      await announce(options, [answer]);
      return completed([...options.messages, answer]);
    });
    const turns: Array<{ seq: number; id: string }> = [];

    await runExploreAgent({
      ...base,
      question: "q",
      repoMap: false,
      onTurn: (turn) => {
        turns.push({ seq: turn.seq, id: turn.message.id });
      },
    });

    expect(turns).toEqual([
      { seq: 0, id: expect.stringMatching(/^explore-user-/) },
      { seq: 1, id: "a1" },
      { seq: 2, id: FORCE_FINAL_MESSAGE_ID },
      { seq: 3, id: "a2" },
    ]);
  });

  it("passes takeSteeringMessages and onMessagesChange through to the master loop only", async () => {
    runAgentLoop
      .mockResolvedValueOnce({
        stopReason: "max-iterations",
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      .mockResolvedValueOnce(completed([assistant("a2", "final")]));
    const takeSteeringMessages = vi.fn(() => []);
    const onMessagesChange = vi.fn();

    await runExploreAgent({
      ...base,
      question: "q",
      repoMap: false,
      takeSteeringMessages,
      onMessagesChange,
    });

    const master = runAgentLoop.mock.calls[0]?.[0] as LoopOptions;
    const synth = runAgentLoop.mock.calls[1]?.[0] as LoopOptions;
    expect(master.takeSteeringMessages).toBe(takeSteeringMessages);
    expect(synth.takeSteeringMessages).toBeUndefined();
    expect(master.onMessagesChange).toBe(onMessagesChange);
    expect(synth.onMessagesChange).toBe(onMessagesChange);
  });

  it("forwards per-dispatch usage to onUsage for the master and to each helper's hooks", async () => {
    runAgentLoop.mockImplementation(async (options: AgentLoopOptions) => {
      if (isHelper(options)) {
        await options.onUsage?.({ inputTokens: 2, outputTokens: 1, costUsd: 0.02 });
        return completed([assistant("h", "helper report")]);
      }
      if (runAgentLoop.mock.calls.filter(([call]) => !isHelper(call)).length === 1) {
        await options.onUsage?.({ inputTokens: 5, outputTokens: 1, costUsd: 0.05 });
        const delegate = options.tools.find((tool) => tool.name === "delegate_explore");
        await delegate?.execute(
          {
            agents: [
              { focus: "a", question: "qa" },
              { focus: "b", question: "qb" },
            ],
          },
          new AbortController().signal,
        );
      }
      return completed([assistant("a1", "done")]);
    });
    const onUsage = vi.fn();
    const helperUsage = vi.fn();
    const result = await runExploreAgent({
      ...base,
      question: "q",
      repoMap: false,
      onUsage,
      onHelperStart: () => ({ helperRunId: "h1", onUsage: helperUsage }),
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 5, costUsd: 0.05 }),
    );
    expect(helperUsage).toHaveBeenCalledTimes(2);
    expect(result.usage.costUsd).toBeCloseTo(0.09, 10);
  });

  it("wraps a master failure with the usage already spent", async () => {
    runAgentLoop.mockImplementationOnce(async (options) => {
      await options.onUsage?.({ inputTokens: 9, outputTokens: 9, costUsd: 0.5 });
      throw new Error("upstream 401");
    });
    const error = await runExploreAgent({ ...base, question: "q", repoMap: false }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExploreAgentError);
    const failure = error as InstanceType<typeof ExploreAgentError>;
    expect(failure.message).toBe("upstream 401");
    expect(failure.usage.costUsd).toBe(0.5);
    expect((failure.cause as Error).message).toBe("upstream 401");
  });
});

describe("delegate_explore helpers", () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
  });

  /** Master calls delegate_explore with `agents`, then answers from the reports. */
  function scriptMaster(agents: Array<{ focus: string; question: string }>) {
    const reports: string[] = [];
    let inFlight = 0;
    let peak = 0;
    runAgentLoop.mockImplementation(async (options) => {
      if (isHelper(options)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const seed = options.messages[0]?.parts[0] as { content?: string } | undefined;
        const focus = String(seed?.content?.split("\n")[0]);
        if (focus.includes("broken")) throw new Error("helper model exploded");
        const answer = assistant(`${options.messages[0]?.id}-a`, `report for ${focus}`);
        await announce(options, [answer], { inputTokens: 2, outputTokens: 1, costUsd: 0.001 });
        return completed([...options.messages, answer]);
      }
      if (isSynthesis(options)) return completed([assistant("s", "synth")]);
      const delegate = options.tools.find((tool) => tool.name === "delegate_explore");
      const signal = new AbortController().signal;
      const report = await delegate?.execute(delegate.inputSchema.parse({ agents }), signal);
      reports.push(String(report));
      await options.onUsage?.({ inputTokens: 100, outputTokens: 10, costUsd: 0.1 });
      return completed([assistant("m", "master answer")], { inputTokens: 0, outputTokens: 0 });
    });
    return { reports, peak: () => peak };
  }

  const fourAgents = [
    { focus: "docs", question: "what do the docs say?" },
    { focus: "src", question: "what is exported?" },
    { focus: "examples", question: "how is it called?" },
    { focus: "types", question: "what are the types?" },
  ];

  it("runs up to four helpers, at most three at once, with their own budgets and model", async () => {
    const script = scriptMaster(fourAgents);
    const result = await runExploreAgent({
      ...base,
      helperModel: "vendor/small-model",
      question: "q",
      cacheKey: "run-1",
    });

    const helperCalls = runAgentLoop.mock.calls
      .map((call) => call[0] as LoopOptions)
      .filter(isHelper);
    expect(helperCalls).toHaveLength(4);
    expect(script.peak()).toBe(3);
    const budgets = deriveExploreBudgets();
    for (const call of helperCalls) {
      expect(call.model.model).toBe("vendor/small-model");
      expect(call.maxIterations).toBe(budgets.helperMaxIterations);
      expect(call.maxIterations).toBe(6);
      expect(call.timeoutMs).toBe(90_000);
      expect(call.deadlineAt).toEqual(expect.any(Number));
      expect(call.cacheKey).toBe("run-1:helper");
      expect(call.tools.map((tool) => tool.name)).toEqual(["glob", "grep", "read"]);
      expect(call.systemPrompt).not.toContain(MASTER_DELEGATE_PROMPT);
      expect((call as LoopOptions).takeSteeringMessages).toBeUndefined();
    }
    expect(result.delegateCalls).toBe(1);
    expect(result.helperRuns.map((run) => run.focus).sort()).toEqual([
      "docs",
      "examples",
      "src",
      "types",
    ]);
    expect(script.reports[0]).toContain("<<<UNTRUSTED_WEB_CONTENT_START>>>");
    expect(script.reports[0]).toContain("report for Focus: docs");
  });

  it("gives helpers the master's overview with the same edited label", async () => {
    scriptMaster(fourAgents.slice(0, 2));
    await runExploreAgent({
      ...base,
      question: "q",
      overview: "OWNER-EDIT-MARK",
      overviewSource: "owner",
    });
    const calls = runAgentLoop.mock.calls.map((call) => call[0] as LoopOptions);
    const helperCalls = calls.filter(isHelper);
    expect(helperCalls).toHaveLength(2);
    for (const call of [...helperCalls, ...calls.filter((c) => !isHelper(c))]) {
      expect(call.systemPrompt).toContain("OWNER-EDIT-MARK");
      expect(call.systemPrompt).toContain("(edited by the package's owner, verify with tools)");
      expect(call.systemPrompt).not.toContain("(model-written, verify with tools)");
    }
  });

  it("reports helper start and finish with the hooks onHelperStart returned", async () => {
    scriptMaster(fourAgents.slice(0, 2));
    const helperTurns: Record<string, string[]> = {};
    const finished: Array<{ id?: string; answer: string }> = [];

    const result = await runExploreAgent({
      ...base,
      question: "q",
      onHelperStart: async (helper) => {
        const helperRunId = `child-${helper.index}`;
        helperTurns[helperRunId] = [];
        return {
          helperRunId,
          onTurn: (turn) => {
            helperTurns[helperRunId]?.push(turn.message.id);
          },
        };
      },
      onHelperFinish: (run) => {
        finished.push({ id: run.helperRunId, answer: run.answer });
      },
    });

    expect(Object.keys(helperTurns).sort()).toEqual(["child-0", "child-1"]);
    expect(helperTurns["child-0"]).toEqual(["explore-helper-0-user", "explore-helper-0-user-a"]);
    expect(finished.map((run) => run.id).sort()).toEqual(["child-0", "child-1"]);
    expect(result.helperRuns.every((run) => run.helperRunId?.startsWith("child-"))).toBe(true);
    expect(result.helperRuns[0]?.stopReason).toBe("completed");
  });

  it("sums master, helper and synthesis usage including costUsd", async () => {
    scriptMaster(fourAgents);
    const result = await runExploreAgent({ ...base, question: "q" });
    expect(result.ownUsage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(result.usage).toMatchObject({ inputTokens: 108, outputTokens: 14 });
    expect(result.usage.costUsd).toBeCloseTo(0.104);
    expect(result.helperRuns.every((run) => run.usage.costUsd === 0.001)).toBe(true);
  });

  it("keeps going when one helper fails, and says so in the report", async () => {
    const script = scriptMaster([
      { focus: "broken", question: "x" },
      { focus: "src", question: "y" },
    ]);
    const finished = vi.fn();
    const result = await runExploreAgent({ ...base, question: "q", onHelperFinish: finished });
    const broken = result.helperRuns.find((run) => run.focus === "broken");
    expect(broken?.error).toBe("helper model exploded");
    expect(broken?.stopReason).toBeUndefined();
    expect(finished).toHaveBeenCalledTimes(2);
    expect(script.reports[0]).toContain("failed: helper model exploded");
    expect(result.answer).toBe("master answer");
  });

  it("shares three helper slots across parallel delegate calls and caps calls per run", async () => {
    let inFlight = 0;
    let peak = 0;
    const outcomes: string[] = [];
    runAgentLoop.mockImplementation(async (options) => {
      if (isHelper(options)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return completed([...options.messages, assistant(`${options.messages[0]?.id}-a`, "r")]);
      }
      if (isSynthesis(options)) return completed([assistant("s", "synth")]);
      const delegate = options.tools.find((tool) => tool.name === "delegate_explore");
      if (!delegate) throw new Error("no delegate tool");
      const signal = new AbortController().signal;
      const call = () =>
        Promise.resolve(
          delegate.execute(delegate.inputSchema.parse({ agents: fourAgents }), signal),
        ).then(
          () => "ok",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      // One turn emitting two delegate calls: TanStack AI runs them in parallel.
      outcomes.push(...(await Promise.all([call(), call()])));
      outcomes.push(await call());
      outcomes.push(await call());
      return completed([assistant("m", "master answer")]);
    });

    const result = await runExploreAgent({ ...base, question: "q", repoMap: false });

    expect(peak).toBe(3);
    expect(outcomes.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    expect(outcomes[3]).toMatch(/delegate_explore limit reached \(3 per investigation\)/);
    expect(result.delegateCalls).toBe(3);
    expect(result.helperRuns).toHaveLength(12);
    expect(new Set(result.helperRuns.map((run) => run.index)).size).toBe(12);
  });

  it("never starts a helper still queued for a slot when the run aborts", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let helpersStarted = 0;
    let delegateOutput: unknown;
    runAgentLoop.mockImplementation(async (options) => {
      if (isHelper(options)) {
        helpersStarted += 1;
        await gate;
        return completed([...options.messages, assistant(`${options.messages[0]?.id}-a`, "r")]);
      }
      if (isSynthesis(options)) return completed([assistant("s", "synth")]);
      const delegate = options.tools.find((tool) => tool.name === "delegate_explore");
      if (!delegate) throw new Error("no delegate tool");
      const controller = new AbortController();
      const pending = Promise.resolve(
        delegate.execute(delegate.inputSchema.parse({ agents: fourAgents }), controller.signal),
      );
      await vi.waitFor(() => expect(helpersStarted).toBe(3));
      controller.abort();
      release();
      delegateOutput = await pending;
      return completed([assistant("m", "master answer")]);
    });
    const onHelperStart = vi.fn();
    const onHelperFinish = vi.fn();

    const result = await runExploreAgent({
      ...base,
      question: "q",
      repoMap: false,
      onHelperStart,
      onHelperFinish,
    });

    expect(helpersStarted).toBe(3);
    expect(onHelperStart).toHaveBeenCalledTimes(3);
    expect(onHelperFinish).toHaveBeenCalledTimes(3);
    expect(result.helperRuns).toHaveLength(3);
    expect(JSON.stringify(delegateOutput)).toContain("Helper not started");
  });

  it("rejects fewer than two or more than four helper briefs", async () => {
    runAgentLoop.mockResolvedValue(completed([assistant("m", "ok")]));
    await runExploreAgent({ ...base, question: "q", repoMap: false });
    const master = runAgentLoop.mock.calls[0]?.[0];
    if (!master) throw new Error("master loop not dispatched");
    const delegate = master.tools.find((tool) => tool.name === "delegate_explore");
    expect(delegate?.inputSchema.safeParse({ agents: fourAgents.slice(0, 1) }).success).toBe(false);
    expect(
      delegate?.inputSchema.safeParse({ agents: [...fourAgents, fourAgents[0]] }).success,
    ).toBe(false);
    expect(delegate?.untrusted).toBe(true);
  });
});

describe("deriveExploreBudgets", () => {
  it("derives the expected budgets at the env defaults", () => {
    expect(deriveExploreBudgets()).toEqual({
      maxIterations: 100,
      timeoutMs: 600_000,
      helperMaxIterations: 6,
      helperTimeoutMs: 90_000,
      synthesisTimeoutMs: 90_000,
      summaryMaxIterations: 30,
      summaryTimeoutMs: 300_000,
    });
  });

  it("scales with smaller budgets and keeps floors", () => {
    const small = deriveExploreBudgets({ maxIterations: 10, timeoutMs: 30_000 });
    expect(small.helperMaxIterations).toBe(2);
    expect(small.summaryMaxIterations).toBe(5);
    expect(small.synthesisTimeoutMs).toBe(30_000);
    expect(small.helperTimeoutMs).toBe(10_000);
  });
});
