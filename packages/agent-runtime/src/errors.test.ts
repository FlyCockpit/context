import { describe, expect, it } from "vitest";

import { errorFromRunErrorChunk, errorUsage } from "./errors";

describe("errorFromRunErrorChunk", () => {
  it("reads the status from the chunk's code, its error, or the raw provider event", () => {
    expect(errorFromRunErrorChunk({ message: "m", code: "429" })).toMatchObject({ status: 429 });
    expect(errorFromRunErrorChunk({ error: { message: "m", code: "503" } })).toMatchObject({
      status: 503,
      message: "m",
    });
    expect(errorFromRunErrorChunk({ message: "m", rawEvent: { code: 400 } })).toMatchObject({
      status: 400,
      code: "400",
    });
  });

  it("maps context overflow to a non-retryable 400 and aborts to an AbortError", () => {
    expect(errorFromRunErrorChunk({ code: "context_overflow", message: "m" })).toMatchObject({
      status: 400,
    });
    expect(errorFromRunErrorChunk({ code: "aborted" }).name).toBe("AbortError");
  });

  it("leaves the status unset when the chunk names none", () => {
    const error = errorFromRunErrorChunk({});
    expect(error.message).toBe("Model request failed");
    expect(error).not.toHaveProperty("status");
  });
});

describe("errorFromRunErrorChunk usage", () => {
  it("keeps the usage a failed stream reported, in either shape", () => {
    const legacy = errorFromRunErrorChunk({
      message: "cut off",
      code: "max_tokens",
      usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160, cost: 0.002 },
    });
    expect(errorUsage(legacy)).toMatchObject({
      promptTokens: 120,
      completionTokens: 40,
      cost: 0.002,
    });

    const spec = errorFromRunErrorChunk({
      message: "reset",
      usage: [{ inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
    });
    expect(errorUsage(spec)).toMatchObject({ promptTokens: 7, completionTokens: 3 });
  });

  it("keeps usage on a stopped stream too", () => {
    const aborted = errorFromRunErrorChunk({
      code: "aborted",
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    });
    expect(aborted.name).toBe("AbortError");
    expect(errorUsage(aborted)).toMatchObject({ promptTokens: 5, completionTokens: 1 });
  });

  it("carries no usage when the chunk reported none or a malformed one", () => {
    expect(errorUsage(errorFromRunErrorChunk({ message: "m", code: "503" }))).toBeUndefined();
    expect(
      errorUsage(errorFromRunErrorChunk({ message: "m", usage: { promptTokens: "7" } })),
    ).toBeUndefined();
    expect(errorUsage(errorFromRunErrorChunk({ message: "m", usage: [] }))).toBeUndefined();
  });
});
