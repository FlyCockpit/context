import { describe, expect, it } from "vitest";

import { landingEntry } from "./landing-entry";

const closed = { forceSso: false, signupOpen: false, adminBootstrapSignupEnabled: false };

describe("landingEntry", () => {
  it("offers sign-in only while the config is loading or sign-up is closed", () => {
    expect(landingEntry(undefined)).toBeNull();
    expect(landingEntry(closed)).toBeNull();
  });

  it("offers server setup while the first-admin bootstrap is open", () => {
    expect(landingEntry({ ...closed, adminBootstrapSignupEnabled: true })).toBe("setup");
  });

  it("offers account creation while open sign-up is on", () => {
    expect(landingEntry({ ...closed, signupOpen: true })).toBe("signup");
  });

  it("offers neither on an SSO-only server", () => {
    expect(
      landingEntry({ forceSso: true, signupOpen: true, adminBootstrapSignupEnabled: true }),
    ).toBeNull();
  });
});
