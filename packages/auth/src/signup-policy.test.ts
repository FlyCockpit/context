import { describe, expect, it } from "vitest";

import {
  resolveAdminBootstrapOpen,
  resolveAdminSetupState,
  resolveSignupOpen,
} from "./signup-policy";

describe("resolveSignupOpen (env AND setting)", () => {
  it("is closed whenever the env ceiling is off, whatever the setting says", () => {
    for (const stored of [undefined, null, "true", "false", "garbage"]) {
      expect(resolveSignupOpen(false, stored)).toBe(false);
    }
  });

  it("treats an absent row as open when the env allows it (default behavior)", () => {
    expect(resolveSignupOpen(true, undefined)).toBe(true);
    expect(resolveSignupOpen(true, null)).toBe(true);
  });

  it("follows the stored toggle when the env allows it", () => {
    expect(resolveSignupOpen(true, "true")).toBe(true);
    expect(resolveSignupOpen(true, "false")).toBe(false);
  });

  it("fails closed on a corrupt stored value", () => {
    expect(resolveSignupOpen(true, "yes")).toBe(false);
    expect(resolveSignupOpen(true, "")).toBe(false);
  });
});

describe("resolveAdminBootstrapOpen (closes once ANY account exists)", () => {
  const base = { adminEmailCount: 1, usersExist: false, tokenActive: true };

  it("is open with an allowlist, no account and an active token", () => {
    expect(resolveAdminBootstrapOpen(base)).toBe(true);
  });

  it("needs an allowlist", () => {
    expect(resolveAdminBootstrapOpen({ ...base, adminEmailCount: 0 })).toBe(false);
  });

  it("closes for good once any account exists, admin or not", () => {
    expect(resolveAdminBootstrapOpen({ ...base, usersExist: true })).toBe(false);
  });

  it("needs this process to hold an unconsumed token", () => {
    expect(resolveAdminBootstrapOpen({ ...base, tokenActive: false })).toBe(false);
  });
});

describe("resolveAdminSetupState", () => {
  it("is null once an admin exists", () => {
    expect(
      resolveAdminSetupState({ adminExists: true, adminBootstrapOpen: false, usersExist: true }),
    ).toBeNull();
  });

  it("offers the bootstrap while it is open", () => {
    expect(
      resolveAdminSetupState({ adminExists: false, adminBootstrapOpen: true, usersExist: false }),
    ).toBe("bootstrap");
  });

  it("asks to configure ADMIN_EMAILS and restart when no account exists", () => {
    expect(
      resolveAdminSetupState({ adminExists: false, adminBootstrapOpen: false, usersExist: false }),
    ).toBe("configure");
  });

  it("reports a locked server when accounts exist but none is an admin", () => {
    expect(
      resolveAdminSetupState({ adminExists: false, adminBootstrapOpen: false, usersExist: true }),
    ).toBe("locked");
  });
});
