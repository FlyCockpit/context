import { describe, expect, it } from "vitest";

import { signupMode } from "./signup-mode";

describe("signupMode", () => {
  it.each([
    [{ signupOpen: true }, "open"],
    [{ signupOpen: false, adminBootstrapSignupEnabled: true }, "bootstrap"],
    [{ signupOpen: false, adminBootstrapSignupEnabled: false }, "closed"],
    [{}, "closed"],
    [{ forceSso: true, signupOpen: true }, "sso"],
    [{ forceSso: true, adminBootstrapSignupEnabled: true }, "sso"],
  ] as const)("%o is %s", (config, mode) => {
    expect(signupMode(config)).toBe(mode);
  });
});
