import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseResetPasswordSearch } from "./reset-password-search";

describe("parseResetPasswordSearch", () => {
  it("recognizes an invite through the router's actual search parser", () => {
    expect(parseResetPasswordSearch(defaultParseSearch("?token=one-time&invite=1"))).toEqual({
      token: "one-time",
      error: undefined,
      invite: true,
    });
  });
  it("also handles an unparsed invite marker", () => {
    expect(parseResetPasswordSearch({ invite: "1" }).invite).toBe(true);
  });
  it("preserves ordinary reset and invalid-token behavior", () => {
    expect(
      parseResetPasswordSearch(defaultParseSearch("?token=reset&error=INVALID_TOKEN")),
    ).toEqual({
      token: "reset",
      error: "INVALID_TOKEN",
      invite: undefined,
    });
  });
  it("ignores unrelated markers and non-string tokens", () => {
    expect(parseResetPasswordSearch({ token: 12, error: [], invite: "0" })).toEqual({
      token: undefined,
      error: undefined,
      invite: undefined,
    });
  });
});
