import { afterEach, describe, expect, it, vi } from "vitest";

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

const {
  errorCode,
  errorReason,
  friendly,
  isAccountExistsRejection,
  isCodeRejection,
  isCredentialRejection,
} = await import("./friendly-error");

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

describe("friendly: network failures say what to do", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a failed request while offline to the offline copy, over any fallback", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(friendly(new TypeError("Failed to fetch"), "Couldn't save.")).toBe("errors:offline");
  });

  it("maps a failed fetch while online to the unreachable copy", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(friendly(new TypeError("Failed to fetch"))).toBe("errors:unreachable");
  });

  it("keeps mapping server answers by code, offline or not", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(friendly({ status: 409, code: "CONFLICT" })).toBe("conflict");
  });
});

describe("isCredentialRejection: only a wrong email or password is a field error", () => {
  it("is true for Better-Auth's wrong-credentials answer", () => {
    expect(isCredentialRejection({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(true);
  });

  it("is false for a 401 that is not about the credentials", () => {
    // Better-Auth answers this after accepting a correct email and password.
    expect(isCredentialRejection({ status: 401, code: "FAILED_TO_CREATE_SESSION" })).toBe(false);
    expect(isCredentialRejection({ status: 401 })).toBe(false);
  });

  it("is false for server errors, rate limits and network failures", () => {
    expect(isCredentialRejection({ status: 500, code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    expect(isCredentialRejection({ status: 502 })).toBe(false);
    expect(isCredentialRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCredentialRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCredentialRejection(undefined)).toBe(false);
  });
});

describe("isCodeRejection: only a wrong or expired code is a code-field error", () => {
  it("is true for Better-Auth's code rejections", () => {
    expect(isCodeRejection({ status: 401, code: "INVALID_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "INVALID_BACKUP_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "OTP_HAS_EXPIRED" })).toBe(true);
  });

  it("is false for rate limits, lockouts, an expired 2FA session and failures", () => {
    expect(isCodeRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCodeRejection({ status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" })).toBe(false);
    expect(isCodeRejection({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" })).toBe(false);
    expect(isCodeRejection({ status: 503 })).toBe(false);
    expect(isCodeRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("isAccountExistsRejection: only an already-registered address is an email-field error", () => {
  it("is true for Better-Auth's duplicate sign-up answer (no SMTP) and a 409", () => {
    expect(
      isAccountExistsRejection({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" }),
    ).toBe(true);
    expect(isAccountExistsRejection({ status: 422, code: "USER_ALREADY_EXISTS" })).toBe(true);
    expect(isAccountExistsRejection({ status: 409 })).toBe(true);
  });

  it("is false for the other 422s (sign-up closed, bootstrap refused) and failures", () => {
    // The same answer for every address, so it says nothing about the address.
    expect(isAccountExistsRejection({ status: 422, code: "FAILED_TO_CREATE_USER" })).toBe(false);
    expect(isAccountExistsRejection({ status: 422 })).toBe(false);
    expect(isAccountExistsRejection({ status: 403, code: "SIGNUP_DISABLED" })).toBe(false);
    expect(isAccountExistsRejection({ status: 503 })).toBe(false);
    expect(isAccountExistsRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});
