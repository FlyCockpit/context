import { describe, expect, it } from "vitest";

import { errorFromRunErrorChunk } from "./errors";

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
