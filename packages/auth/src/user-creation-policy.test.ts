import { describe, expect, it } from "vitest";

import { resolveSignupOpen } from "./signup-policy";
import {
  decideUserCreation,
  FIRST_ACCOUNT_REQUIRES_BOOTSTRAP_MESSAGE,
  getAllowedUserCreationMode,
  getGrantedUserLocale,
  runWithAllowedUserCreation,
  SIGNUP_DISABLED_MESSAGE,
  type UserCreationMode,
} from "./user-creation-policy";

describe("user creation policy context", () => {
  it("is unset by default", () => {
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });

  it("preserves the creation mode across async work", async () => {
    await runWithAllowedUserCreation("admin-bootstrap", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getAllowedUserCreationMode()).toBe("admin-bootstrap");
    });
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });

  it("keeps the stable message the admin-invite error translation matches on", () => {
    expect(SIGNUP_DISABLED_MESSAGE).toMatch(/sign-?up.*disabled/i);
  });
});

describe("granted locale", () => {
  it("carries the server-chosen locale only inside its grant", async () => {
    expect(getGrantedUserLocale()).toBeUndefined();
    await runWithAllowedUserCreation(
      "admin-invite",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getGrantedUserLocale()).toBe("es-MX");
      },
      { locale: "es-MX" },
    );
    await runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(getGrantedUserLocale()).toBeUndefined();
    });
    expect(getGrantedUserLocale()).toBeUndefined();
  });
});

// The signup gate matrix from docs/product.md: env SIGNUP_ENABLED ×
// the admin's `signupOpen` setting × whether the address is the ADMIN_EMAILS
// bootstrap. `signupOpen` here is the composed effective value, exactly as the
// Better-Auth hook computes it.
describe("signup gate matrix (SMTP configured, email verification enabled)", () => {
  type Row = {
    env: boolean;
    setting: string | undefined;
    bootstrap: boolean;
    allowed: boolean;
    role?: "admin";
  };
  const rows: Row[] = [
    // env off: the ceiling. Only the bootstrap address gets in.
    { env: false, setting: undefined, bootstrap: false, allowed: false },
    { env: false, setting: "true", bootstrap: false, allowed: false },
    { env: false, setting: "false", bootstrap: false, allowed: false },
    { env: false, setting: undefined, bootstrap: true, allowed: true, role: "admin" },
    { env: false, setting: "true", bootstrap: true, allowed: true, role: "admin" },
    { env: false, setting: "false", bootstrap: true, allowed: true, role: "admin" },
    // env on: the setting decides; absent means open.
    { env: true, setting: undefined, bootstrap: false, allowed: true },
    { env: true, setting: "true", bootstrap: false, allowed: true },
    { env: true, setting: "false", bootstrap: false, allowed: false },
    { env: true, setting: undefined, bootstrap: true, allowed: true, role: "admin" },
    { env: true, setting: "true", bootstrap: true, allowed: true, role: "admin" },
    { env: true, setting: "false", bootstrap: true, allowed: true, role: "admin" },
  ];

  it.each(rows)(
    "env=$env setting=$setting bootstrap=$bootstrap → allowed=$allowed role=$role",
    (row) => {
      const decision = decideUserCreation({
        signupOpen: resolveSignupOpen(row.env, row.setting),
        creationMode: row.bootstrap ? "admin-bootstrap" : undefined,
        isAdminEmail: row.bootstrap,
        emailConfigured: true,
        // The bootstrap rows are the first account; the others sign up once
        // the administrator exists (before that only the bootstrap is
        // admitted: "first account" below).
        usersExist: !row.bootstrap,
        bootstrapTokenValid: row.bootstrap,
      });
      if (!row.allowed) {
        expect(decision).toEqual({ allowed: false, reason: SIGNUP_DISABLED_MESSAGE });
        return;
      }
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) return;
      expect(decision.role).toBe(row.role);
      // SMTP is configured: verification stays required.
      expect(decision.forceEmailVerified).toBe(false);
    },
  );

  it.each([true, false])(
    "closes the bootstrap once any account exists, even with the token (SMTP=%s)",
    (emailConfigured) => {
      const decision = decideUserCreation({
        signupOpen: false,
        creationMode: "admin-bootstrap",
        isAdminEmail: true,
        emailConfigured,
        usersExist: true,
        bootstrapTokenValid: true,
      });
      expect(decision).toEqual({ allowed: false, reason: SIGNUP_DISABLED_MESSAGE });
    },
  );
});

// CTX-01: a wrong token for the admin address used to fall through to open
// signup and create a plain first account, closing the bootstrap for good.
describe("first account", () => {
  const refused = { allowed: false, reason: FIRST_ACCOUNT_REQUIRES_BOOTSTRAP_MESSAGE };
  type Case = {
    name: string;
    creationMode: UserCreationMode | undefined;
    isAdminEmail: boolean;
    bootstrapTokenValid: boolean;
  };
  const cases: Case[] = [
    // The server marker only sets the bootstrap mode for a listed address with
    // the valid token, so a wrong token arrives here with no mode.
    {
      name: "listed address, wrong token",
      creationMode: undefined,
      isAdminEmail: true,
      bootstrapTokenValid: false,
    },
    {
      name: "unlisted address, no token",
      creationMode: undefined,
      isAdminEmail: false,
      bootstrapTokenValid: false,
    },
    {
      name: "unlisted address, valid token",
      creationMode: "admin-bootstrap",
      isAdminEmail: false,
      bootstrapTokenValid: true,
    },
    {
      name: "bootstrap mode with a stale token",
      creationMode: "admin-bootstrap",
      isAdminEmail: true,
      bootstrapTokenValid: false,
    },
  ];

  it.each(
    cases.flatMap((c) =>
      [true, false].flatMap((signupOpen) =>
        [true, false].map((emailConfigured) => ({ ...c, signupOpen, emailConfigured })),
      ),
    ),
  )(
    "refuses $name with one message (signupOpen=$signupOpen, SMTP=$emailConfigured)",
    ({ creationMode, isAdminEmail, bootstrapTokenValid, signupOpen, emailConfigured }) => {
      expect(
        decideUserCreation({
          signupOpen,
          creationMode,
          isAdminEmail,
          emailConfigured,
          usersExist: false,
          bootstrapTokenValid,
        }),
      ).toEqual(refused);
    },
  );

  it("still admits the real bootstrap with open signup, as admin", () => {
    expect(
      decideUserCreation({
        signupOpen: true,
        creationMode: "admin-bootstrap",
        isAdminEmail: true,
        emailConfigured: true,
        usersExist: false,
        bootstrapTokenValid: true,
      }),
    ).toEqual({ allowed: true, role: "admin", forceEmailVerified: false });
  });

  it("lets open signup admit plain accounts once an account exists", () => {
    expect(
      decideUserCreation({
        signupOpen: true,
        creationMode: undefined,
        isAdminEmail: true,
        emailConfigured: true,
        usersExist: true,
        bootstrapTokenValid: false,
      }),
    ).toEqual({ allowed: true, forceEmailVerified: false });
  });
});

describe("admin invites", () => {
  it.each([true, false])("work with signup closed (emailConfigured=%s)", (emailConfigured) => {
    const decision = decideUserCreation({
      signupOpen: false,
      creationMode: "admin-invite",
      isAdminEmail: false,
      emailConfigured,
      usersExist: true,
      bootstrapTokenValid: true,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    // The invite keeps the role the admin chose (no hook override)...
    expect(decision.role).toBeUndefined();
    // ...and is usable with its temp password when there is no SMTP.
    expect(decision.forceEmailVerified).toBe(!emailConfigured);
  });

  it("never promotes an invited ADMIN_EMAILS address on its own", () => {
    const decision = decideUserCreation({
      signupOpen: false,
      creationMode: "admin-invite",
      isAdminEmail: true,
      emailConfigured: true,
      usersExist: true,
      bootstrapTokenValid: true,
    });
    expect(decision).toMatchObject({ allowed: true });
    if (decision.allowed) expect(decision.role).toBeUndefined();
  });
});

describe("email optional (no SMTP)", () => {
  it("creates open-signup accounts already verified", () => {
    const decision = decideUserCreation({
      signupOpen: true,
      creationMode: undefined,
      isAdminEmail: false,
      emailConfigured: false,
      usersExist: true,
      bootstrapTokenValid: true,
    });
    expect(decision).toEqual({ allowed: true, forceEmailVerified: true });
  });

  it("lets the first listed address bootstrap as a verified admin", () => {
    const decision = decideUserCreation({
      signupOpen: false,
      creationMode: "admin-bootstrap",
      isAdminEmail: true,
      emailConfigured: false,
      usersExist: false,
      bootstrapTokenValid: true,
    });
    expect(decision).toEqual({ allowed: true, role: "admin", forceEmailVerified: true });
  });

  it("closes the bootstrap once any account exists (no pre-claim of a listed address)", () => {
    const closed = decideUserCreation({
      signupOpen: false,
      creationMode: "admin-bootstrap",
      isAdminEmail: true,
      emailConfigured: false,
      usersExist: true,
      bootstrapTokenValid: true,
    });
    expect(closed).toEqual({ allowed: false, reason: SIGNUP_DISABLED_MESSAGE });

    // With open signup the listed address still registers, but as a plain user.
    const open = decideUserCreation({
      signupOpen: true,
      creationMode: "admin-bootstrap",
      isAdminEmail: true,
      emailConfigured: false,
      usersExist: true,
      bootstrapTokenValid: true,
    });
    expect(open).toEqual({ allowed: true, forceEmailVerified: true });
  });
});

describe("bootstrap marker is re-checked", () => {
  it.each<UserCreationMode | undefined>(["admin-bootstrap", undefined])(
    "an unlisted address is never promoted (mode=%s)",
    (creationMode) => {
      const decision = decideUserCreation({
        signupOpen: true,
        creationMode,
        isAdminEmail: false,
        emailConfigured: true,
        usersExist: true,
        bootstrapTokenValid: true,
      });
      expect(decision).toEqual({ allowed: true, forceEmailVerified: false });
    },
  );

  it("an unlisted address carrying the bootstrap mode is refused when signup is closed", () => {
    const decision = decideUserCreation({
      signupOpen: false,
      creationMode: "admin-bootstrap",
      isAdminEmail: false,
      emailConfigured: true,
      usersExist: false,
      bootstrapTokenValid: true,
    });
    expect(decision.allowed).toBe(false);
  });
});
