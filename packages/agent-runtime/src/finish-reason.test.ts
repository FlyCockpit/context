import { describe, expect, it } from "vitest";

import { collectFinishReasons, isTruncatedFinish, normalizeFinishReason } from "./finish-reason";

describe("normalizeFinishReason", () => {
  it("maps every provider spelling of the output ceiling to length", () => {
    for (const raw of [
      "length",
      "LENGTH",
      "max_tokens",
      "MAX_TOKENS",
      "maxTokens",
      "max-tokens",
      "max_output_tokens",
      "MAX_OUTPUT_TOKENS",
      "max_completion_tokens",
      "model_length",
      "token_limit",
      "truncated",
    ]) {
      expect(normalizeFinishReason(raw), raw).toBe("length");
    }
  });

  it("maps tool-calling spellings to tool-calls", () => {
    for (const raw of ["tool_calls", "tool_use", "TOOL_CALLS", "function_call"]) {
      expect(normalizeFinishReason(raw), raw).toBe("tool-calls");
    }
  });

  it("maps clean-stop spellings to stop", () => {
    for (const raw of ["stop", "STOP", "end_turn", "stop_sequence", "completed"]) {
      expect(normalizeFinishReason(raw), raw).toBe("stop");
    }
  });

  it("keeps content filtering and errors distinct from a clean stop", () => {
    expect(normalizeFinishReason("content_filter")).toBe("content-filter");
    expect(normalizeFinishReason("SAFETY")).toBe("content-filter");
    expect(normalizeFinishReason("error")).toBe("error");
  });

  it("returns unknown for absent or unrecognized values (never a clean stop by accident)", () => {
    expect(normalizeFinishReason(null)).toBe("unknown");
    expect(normalizeFinishReason(undefined)).toBe("unknown");
    expect(normalizeFinishReason("")).toBe("unknown");
    expect(normalizeFinishReason("something_new")).toBe("unknown");
  });
});

describe("collectFinishReasons / isTruncatedFinish", () => {
  it("reads the primary field, native passthroughs, and incomplete details", () => {
    expect(
      collectFinishReasons({
        finishReason: "stop",
        native_finish_reason: "MAX_TOKENS",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toEqual(["stop", "MAX_TOKENS", "max_output_tokens"]);
  });

  it("detects truncation reported only in a native finish reason", () => {
    expect(isTruncatedFinish({ finishReason: "stop", native_finish_reason: "MAX_TOKENS" })).toBe(
      true,
    );
    expect(isTruncatedFinish({ finishReason: "tool_calls", nativeFinishReason: "length" })).toBe(
      true,
    );
    expect(isTruncatedFinish({ finishReason: "stop", stop_reason: "max_tokens" })).toBe(true);
    expect(
      isTruncatedFinish({
        finishReason: "stop",
        incompleteDetails: { reason: "max_output_tokens" },
      }),
    ).toBe(true);
  });

  it("does not flag a clean finish", () => {
    expect(isTruncatedFinish({ finishReason: "stop" })).toBe(false);
    expect(isTruncatedFinish({ finishReason: "tool_calls" })).toBe(false);
    expect(isTruncatedFinish(null)).toBe(false);
    expect(isTruncatedFinish({})).toBe(false);
  });
});
