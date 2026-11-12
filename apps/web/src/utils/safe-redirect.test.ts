import { describe, expect, it } from "vitest";

import { safeRedirectTo } from "./safe-redirect";

describe("safeRedirectTo", () => {
  it("falls back to the Ongoing page", () => {
    expect(safeRedirectTo(undefined, "en-US")).toBe("/en-US/ongoing");
    expect(safeRedirectTo("https://evil.example/", "en-US")).toBe("/en-US/ongoing");
    expect(safeRedirectTo("/es-MX/packages", "en-US")).toBe("/en-US/ongoing");
  });

  it("never sends a signed-in user back to the auth pages", () => {
    expect(safeRedirectTo("/en-US/login", "en-US")).toBe("/en-US/ongoing");
    expect(safeRedirectTo("/en-US/signup?x=1", "en-US")).toBe("/en-US/ongoing");
  });

  it("keeps an in-app destination of the same locale", () => {
    expect(safeRedirectTo("/en-US/access/tokens", "en-US")).toBe("/en-US/access/tokens");
  });
});
