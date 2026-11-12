import path from "node:path";

import type { AgentLoopOptions, AgentLoopResult } from "@cockpit-context/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoop = vi.fn<(options: AgentLoopOptions) => Promise<AgentLoopResult>>();

vi.mock("@cockpit-context/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("@cockpit-context/agent-runtime")>(
    "@cockpit-context/agent-runtime",
  );
  return { ...actual, runAgentLoop };
});

const { buildCheckoutSummaryPrompt, generateCheckoutSummary } = await import("./summary");

const ROOT = path.resolve(import.meta.dirname, "../fixtures/sample-pkg");

describe("generateCheckoutSummary", () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
    runAgentLoop.mockResolvedValue({
      stopReason: "completed",
      messages: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", content: "sample-pkg exports greet() from src/greet.ts." }],
        },
      ],
      usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.002 },
    });
  });

  it("runs one reduced-budget explore pass without delegation and returns the summary", async () => {
    const result = await generateCheckoutSummary({
      root: ROOT,
      apiKey: "k",
      model: "vendor/main-model",
      ripgrep: false,
      package: { identifier: "npm:sample-pkg", versionOrRef: "1.0.0", commit: "abc" },
    });

    expect(runAgentLoop).toHaveBeenCalledOnce();
    const options = runAgentLoop.mock.calls[0]?.[0] as AgentLoopOptions;
    expect(options.maxIterations).toBe(30);
    expect(options.timeoutMs).toBe(300_000);
    expect(options.tools.some((tool) => tool.name === "delegate_explore")).toBe(false);
    expect(options.systemPrompt).toContain("- Package: npm:sample-pkg");
    expect(options.systemPrompt).not.toContain("Repository overview");
    expect(options.messages[0]?.parts[0]).toMatchObject({
      content: expect.stringContaining('the package "npm:sample-pkg"'),
    });
    expect(result.summary).toBe("sample-pkg exports greet() from src/greet.ts.");
    expect(result.usage.costUsd).toBe(0.002);
  });

  it("honors explicit budgets", async () => {
    await generateCheckoutSummary({
      root: ROOT,
      apiKey: "k",
      model: "m",
      ripgrep: false,
      repoMap: false,
      maxIterations: 8,
      timeoutMs: 20_000,
      package: { identifier: "npm:sample-pkg" },
    });
    const options = runAgentLoop.mock.calls[0]?.[0] as AgentLoopOptions;
    expect(options.maxIterations).toBe(8);
    expect(options.timeoutMs).toBe(20_000);
  });
});

describe("buildCheckoutSummaryPrompt", () => {
  it("covers the overview prompt's five points", () => {
    const prompt = buildCheckoutSummaryPrompt({ identifier: "npm:left-pad" });
    for (const point of [
      "1. What this package/library does",
      "2. The key source files and directories",
      "3. Main exports, entry points, or APIs",
      "4. Important patterns, conventions",
      "5. Any configuration files or build setup",
    ]) {
      expect(prompt).toContain(point);
    }
    expect(prompt).toContain("no preamble or markdown headers");
  });
});
