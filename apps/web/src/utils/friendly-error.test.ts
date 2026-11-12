import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => {
  const copy: Record<string, string> = {
    "errors:generic": "generic",
    "errors:conflict": "conflict",
    "errors:badRequest": "bad request",
    "errors:rateLimited": "rate limited",
    "errors:reasons.PACKAGE_EXISTS": "already in your list",
    "errors:reasons.BUSY": "too many waiting",
  };
  return {
    default: {
      exists: (key: string) => key in copy,
      t: (key: string) => copy[key] ?? key,
    },
  };
});

const { errorCode, errorReason, friendly } = await import("./friendly-error");

describe("friendly", () => {
  it("prefers translated reason copy over the code mapping", () => {
    expect(friendly({ code: "CONFLICT", data: { reason: "PACKAGE_EXISTS" } })).toBe(
      "already in your list",
    );
  });

  it("falls back to the code mapping for a reason without copy", () => {
    expect(friendly({ code: "BAD_REQUEST", data: { reason: "SOMETHING_NEW" } })).toBe(
      "bad request",
    );
  });

  it("explains the queued-run cap (429 with reason BUSY) instead of a retry delay", () => {
    expect(friendly({ code: "TOO_MANY_REQUESTS", data: { reason: "BUSY" } })).toBe(
      "too many waiting",
    );
  });

  it("keeps rate limits ahead of reasons", () => {
    expect(friendly({ code: "TOO_MANY_REQUESTS", data: { reason: "PACKAGE_EXISTS" } })).toBe(
      "rate limited",
    );
  });

  it("never renders the server message", () => {
    expect(friendly({ code: "CONFLICT", message: "raw server text" })).toBe("conflict");
  });
});

describe("errorReason", () => {
  it("returns well-formed reason codes only", () => {
    expect(errorReason({ data: { reason: "VERSION_NOT_FOUND" } })).toBe("VERSION_NOT_FOUND");
    expect(errorReason({ data: { reason: "errors:generic" } })).toBeNull();
    expect(errorReason({ data: { reason: 42 } })).toBeNull();
    expect(errorReason({ code: "CONFLICT" })).toBeNull();
    expect(errorReason(null)).toBeNull();
  });
});

describe("errorCode", () => {
  it("returns the code of an error-shaped value only", () => {
    expect(errorCode({ code: "NOT_FOUND" })).toBe("NOT_FOUND");
    expect(errorCode({ code: 404 })).toBeNull();
    expect(errorCode("NOT_FOUND")).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});
