import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issueBootstrapToken, revokeBootstrapToken } from "./bootstrap-token";
import { createUserCreateBeforeHook } from "./user-create-hook";
import { runWithAllowedUserCreation, serializeSignup } from "./user-creation-policy";

// Drives the REAL Better-Auth sign-up/sign-in endpoints against an in-memory
// adapter (no Postgres, no SMTP), wired the way packages/auth/src/index.ts
// wires them: `requireEmailVerification` and the verification sender exist
// only when SMTP is configured, and every row goes through the hook factory.
const OWNER = "owner@example.com";
const PASSWORD = "correct-horse-battery";

afterEach(() => {
  revokeBootstrapToken();
});

function buildAuth(opts: { emailConfigured: boolean; signupOpen: boolean; usersExist?: boolean }) {
  const db: Record<string, unknown[]> & { user: unknown[] } = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const sendVerificationEmail = vi.fn(async () => {});
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    rateLimit: { enabled: false },
    user: {
      additionalFields: {
        locale: { type: "string", required: false, defaultValue: "en-US", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: opts.emailConfigured,
      minPasswordLength: 12,
    },
    ...(opts.emailConfigured
      ? { emailVerification: { sendVerificationEmail, sendOnSignUp: true, sendOnSignIn: true } }
      : {}),
    plugins: [admin({ defaultRole: "user" })],
    databaseHooks: {
      user: {
        create: {
          before: createUserCreateBeforeHook({
            emailConfigured: opts.emailConfigured,
            adminEmails: new Set([OWNER, "other-owner@example.com"]),
            isSignupOpen: async () => opts.signupOpen,
            hasAnyUser: async () => opts.usersExist ?? db.user.length > 0,
          }),
          // Mirrors packages/auth/src/index.ts: any account spends the token.
          after: async () => {
            revokeBootstrapToken();
          },
        },
      },
    },
  });
  return { auth, db, sendVerificationEmail };
}

function signUp(auth: ReturnType<typeof buildAuth>["auth"], email: string) {
  return auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Someone" } });
}

// What the server marker does for a listed address carrying the header.
function bootstrapSignUp(auth: ReturnType<typeof buildAuth>["auth"], email: string, token: string) {
  return runWithAllowedUserCreation("admin-bootstrap", () => signUp(auth, email), {
    bootstrapToken: token,
  });
}

describe("sign-up without SMTP", () => {
  it("succeeds, is verified, and is signed in straight away", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: true });
    const result = await signUp(auth, "new@example.com");

    expect(result.token).toEqual(expect.any(String));
    expect(result.user.emailVerified).toBe(true);
    expect(db.user).toHaveLength(1);
    expect(db.session).toHaveLength(1);

    const signIn = await auth.api.signInEmail({
      body: { email: "new@example.com", password: PASSWORD },
    });
    expect(signIn.token).toEqual(expect.any(String));
  });

  it("is refused when signup is closed and the address is not the bootstrap", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: false });
    await expect(signUp(auth, "stranger@example.com")).rejects.toMatchObject({
      body: { code: "FAILED_TO_CREATE_USER" },
    });
    expect(db.user).toHaveLength(0);
  });

  it("bootstraps the first ADMIN_EMAILS address with the token as a verified admin", async () => {
    const { auth } = buildAuth({ emailConfigured: false, signupOpen: false });
    const result = await bootstrapSignUp(auth, OWNER, issueBootstrapToken());
    expect(result.token).toEqual(expect.any(String));
    expect(result.user).toMatchObject({ emailVerified: true, role: "admin" });
  });

  it("allows exactly one of two concurrent SMTP-off bootstrap signups with the same token", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: false });
    const token = issueBootstrapToken();
    const results = await Promise.allSettled(
      [OWNER, "other-owner@example.com"].map((email) =>
        // The signup middleware serializes every signup request (see
        // apps/server/src/signup-gate.ts); mirror that here.
        serializeSignup(() => bootstrapSignUp(auth, email, token)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(db.user).toHaveLength(1);
    expect(db.user[0]).toMatchObject({ role: "admin" });
  });

  it("refuses a guessed listed address without the token, or with a wrong or previous-boot token", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: false });
    const previousBoot = issueBootstrapToken();
    issueBootstrapToken(); // restart
    for (const attempt of [
      () => runWithAllowedUserCreation("admin-bootstrap", () => signUp(auth, OWNER)),
      () => bootstrapSignUp(auth, OWNER, "not-the-token"),
      () => bootstrapSignUp(auth, OWNER, previousBoot),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ body: { code: "FAILED_TO_CREATE_USER" } });
    }
    expect(db.user).toHaveLength(0);
  });

  it("refuses the bootstrap once any account exists, even with the token", async () => {
    const { auth } = buildAuth({ emailConfigured: false, signupOpen: false, usersExist: true });
    await expect(bootstrapSignUp(auth, OWNER, issueBootstrapToken())).rejects.toMatchObject({
      body: { code: "FAILED_TO_CREATE_USER" },
    });
  });

  it("spends the token on the first account: reusing it is refused", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: false });
    const token = issueBootstrapToken();
    await bootstrapSignUp(auth, OWNER, token);
    await expect(bootstrapSignUp(auth, "other-owner@example.com", token)).rejects.toMatchObject({
      body: { code: "FAILED_TO_CREATE_USER" },
    });
    expect(db.user).toHaveLength(1);
  });

  it("lets an admin invite through with signup closed, already verified", async () => {
    const { auth } = buildAuth({ emailConfigured: false, signupOpen: false, usersExist: true });
    const created = await runWithAllowedUserCreation("admin-invite", () =>
      auth.api.createUser({
        body: { email: "invitee@example.com", password: PASSWORD, name: "Invitee", role: "user" },
      }),
    );
    expect(created.user).toMatchObject({ emailVerified: true, role: "user" });
    const signIn = await auth.api.signInEmail({
      body: { email: "invitee@example.com", password: PASSWORD },
    });
    expect(signIn.token).toEqual(expect.any(String));
  });
});

describe("sign-up with SMTP", () => {
  it("requires verification: no session, an email goes out, sign-in is refused until verified", async () => {
    const { auth, db, sendVerificationEmail } = buildAuth({
      emailConfigured: true,
      signupOpen: true,
    });
    const result = await signUp(auth, "new@example.com");

    expect(result.token).toBeNull();
    expect(result.user.emailVerified).toBe(false);
    expect(db.session).toHaveLength(0);
    expect(sendVerificationEmail).toHaveBeenCalledOnce();

    await expect(
      auth.api.signInEmail({ body: { email: "new@example.com", password: PASSWORD } }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_NOT_VERIFIED" } });
  });

  it("bootstraps the administrator: a listed address with the token becomes an (unverified) admin", async () => {
    const { auth } = buildAuth({ emailConfigured: true, signupOpen: false });
    const result = await bootstrapSignUp(auth, OWNER, issueBootstrapToken());
    expect(result.token).toBeNull();
    expect(result.user).toMatchObject({ emailVerified: false, role: "admin" });
  });

  it("no longer reopens the bootstrap after the first account (the old SMTP-on window)", async () => {
    const { auth } = buildAuth({ emailConfigured: true, signupOpen: false, usersExist: true });
    await expect(bootstrapSignUp(auth, OWNER, issueBootstrapToken())).rejects.toMatchObject({
      body: { code: "FAILED_TO_CREATE_USER" },
    });
  });

  it("refuses a guessed listed address without the token", async () => {
    const { auth, db } = buildAuth({ emailConfigured: true, signupOpen: false });
    issueBootstrapToken();
    await expect(
      runWithAllowedUserCreation("admin-bootstrap", () => signUp(auth, OWNER)),
    ).rejects.toMatchObject({ body: { code: "FAILED_TO_CREATE_USER" } });
    expect(db.user).toHaveLength(0);
  });
});
