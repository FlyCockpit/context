import { describe, expect, it } from "vitest";

import { sumUsage, UsageMeter } from "./usage";

describe("sumUsage", () => {
  it("adds tokens and cost, keeping the first model", () => {
    expect(
      sumUsage(
        { inputTokens: 1, outputTokens: 2, costUsd: 0.5, model: "a", cachedInputTokens: 3 },
        { inputTokens: 10, outputTokens: 20, costUsd: 0.25, model: "b" },
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 0,
      costUsd: 0.75,
      model: "a",
    });
  });

  it("leaves costUsd undefined when neither side reported one", () => {
    expect(sumUsage({ inputTokens: 1, outputTokens: 1 }, undefined).costUsd).toBeUndefined();
    expect(
      sumUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 0, outputTokens: 0, costUsd: 0 })
        .costUsd,
    ).toBe(0);
  });
});

describe("UsageMeter", () => {
  it("trusts observed dispatches over the result's usage", () => {
    const meter = new UsageMeter();
    meter.onUsage({ inputTokens: 5, outputTokens: 1, costUsd: 0.1 });
    meter.onUsage({ inputTokens: 7, outputTokens: 2, costUsd: 0.2 });
    expect(meter.iterations).toBe(2);
    // A deadline-aborted loop reports zero usage in its result.
    const settled = meter.settle({ inputTokens: 0, outputTokens: 0 });
    expect(settled.inputTokens).toBe(12);
    expect(settled.costUsd).toBeCloseTo(0.3);
  });

  it("falls back to the result's usage when nothing was observed", () => {
    const meter = new UsageMeter();
    expect(meter.settle({ inputTokens: 4, outputTokens: 3 })).toMatchObject({
      inputTokens: 4,
      outputTokens: 3,
    });
    expect(meter.iterations).toBe(0);
  });
});
