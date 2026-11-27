import { createHash } from "node:crypto";
import { APP_LOCALE_HEADER } from "@cockpit-context/config/locales";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adminPluginAccess } from "./admin-access";
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

// Better-Auth's default scrypt hash is deliberately CPU-heavy: several hashes
// per test made these tests' duration depend on machine load (timeouts under
// a busy parallel run). The token, binding and hook logic under test does not
// depend on the hash, so use a cheap deterministic one.
const fastPassword = {
  hash: async (password: string) =>
    `test-sha256:${createHash("sha256").update(password).digest("hex")}`,
  verify: async ({ hash, password }: { hash: string; password: string }) =>
    hash === `test-sha256:${createHash("sha256").update(password).digest("hex")}`,
};

function buildAuth(opts: {
  emailConfigured: boolean;
  signupOpen: boolean;
  usersExist?: boolean;
  /** Cockpit Context's admin-plugin roles (./admin-access.ts) instead of the plugin's defaults. */
  appAdminAccess?: boolean;
}) {
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
      password: fastPassword,
    },
    ...(opts.emailConfigured
      ? { emailVerification: { sendVerificationEmail, sendOnSignUp: true, sendOnSignIn: true } }
      : {}),
    plugins: [admin({ defaultRole: "user", ...(opts.appAdminAccess ? adminPluginAccess : {}) })],
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
    // Open signup applies once the administrator exists ("first account" below).
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: true, usersExist: true });
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
      usersExist: true,
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

  // users.invite creates the account server-side under the "admin-invite"
  // grant. The invitee's language comes from the grant (there is no request
  // header), and nothing mails a "verify your email" link: the emailed
  // set-password link is the only mail, and spending it verifies the address
  // (./invite-verification.ts).
  it("creates an invited user in the invite's language, unverified, with no verification mail", async () => {
    const { auth, db, sendVerificationEmail } = buildAuth({
      emailConfigured: true,
      signupOpen: false,
      usersExist: true,
    });
    await runWithAllowedUserCreation(
      "admin-invite",
      () =>
        auth.api.createUser({
          body: { email: "invitee@example.com", password: PASSWORD, name: "Invitee", role: "user" },
        }),
      { locale: "es-MX" },
    );
    expect(
      db.user.find((u) => (u as { email: string }).email === "invitee@example.com"),
    ).toMatchObject({ locale: "es-MX", emailVerified: false, role: "user" });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("seeds a self sign-up's locale from the client's header", async () => {
    const { auth, db, sendVerificationEmail } = buildAuth({
      emailConfigured: true,
      signupOpen: true,
      usersExist: true,
    });
    await auth.api.signUpEmail({
      body: { email: "self@example.com", password: PASSWORD, name: "Self" },
      headers: new Headers({ [APP_LOCALE_HEADER]: "es-MX" }),
    });
    expect(
      db.user.find((u) => (u as { email: string }).email === "self@example.com"),
    ).toMatchObject({ locale: "es-MX" });
    expect(sendVerificationEmail).toHaveBeenCalledOnce();
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

// CTX-01: with open signup, a wrong token for the admin address used to
// create a plain first account ("Account created"), which closed the bootstrap
// for good and left the server without an administrator.
describe("first account with open signup", () => {
  it.each([true, false])(
    "refuses every non-bootstrap first signup and keeps the bootstrap open (SMTP=%s)",
    async (emailConfigured) => {
      const { auth, db } = buildAuth({ emailConfigured, signupOpen: true });
      const token = issueBootstrapToken();
      // The server marker sets no mode for a wrong token, whatever the address.
      for (const email of [OWNER, "stranger@example.com"]) {
        await expect(signUp(auth, email)).rejects.toMatchObject({
          body: { code: "FAILED_TO_CREATE_USER" },
        });
      }
      // A valid token on an unlisted address (a typo in the email) is refused too.
      await expect(bootstrapSignUp(auth, "typo-owner@example.com", token)).rejects.toMatchObject({
        body: { code: "FAILED_TO_CREATE_USER" },
      });
      expect(db.user).toHaveLength(0);

      const admin = await bootstrapSignUp(auth, OWNER, token);
      expect(admin.user).toMatchObject({ role: "admin" });

      // Now that the administrator exists, open signup admits plain accounts.
      const member = await signUp(auth, "member@example.com");
      expect(member.user).toMatchObject({ role: "user" });
      expect(db.user).toHaveLength(2);
    },
  );
});

// Better-Auth's own `/admin/create-user` route, reached over HTTP with a real
// admin session: it would take an admin-chosen password and
// `data: { emailVerified: true }`. Only `users.invite` (server side, under the
// admin-invite grant) may create users through the admin plugin.
describe("Better-Auth's admin create-user route", () => {
  async function adminRequest(auth: ReturnType<typeof buildAuth>["auth"], body: unknown) {
    await bootstrapSignUp(auth, OWNER, issueBootstrapToken());
    return post(auth, "/admin/create-user", await sessionCookie(auth, OWNER), body);
  }

  it.each([
    [true, {}],
    [true, { data: { emailVerified: true } }],
    [false, { data: { emailVerified: true } }],
  ])("refuses an admin's HTTP call (open signup %s, extra %o)", async (signupOpen, extra) => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen });
    const res = await adminRequest(auth, {
      email: "chosen@example.com",
      password: "admin-chosen-password",
      name: "Chosen",
      ...extra,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "ADMIN_CREATE_USER_UNSUPPORTED" });
    expect(db.user).toHaveLength(1);
  });

  it("refuses a verified row even under the invite grant", async () => {
    const { auth, db } = buildAuth({ emailConfigured: true, signupOpen: false, usersExist: true });
    await expect(
      runWithAllowedUserCreation("admin-invite", () =>
        auth.api.createUser({
          body: {
            email: "invitee@example.com",
            password: PASSWORD,
            name: "Invitee",
            data: { emailVerified: true },
          },
        }),
      ),
    ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    expect(db.user).toHaveLength(0);
  });
});

async function sessionCookie(auth: ReturnType<typeof buildAuth>["auth"], email: string) {
  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

function post(
  auth: ReturnType<typeof buildAuth>["auth"],
  path: string,
  cookie: string,
  body: unknown,
) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// No Better-Auth route changes an address or asserts it verified: `/update-user`
// refuses `email` itself, `/change-email` is not configured, and the app's admin
// role lacks `set-email`, which `/admin/update-user` requires for `email` and
// `emailVerified` (./admin-access.ts). An admin's word is not mailbox proof.
describe("email changes", () => {
  it("refuses an admin's email or verification change through /admin/update-user", async () => {
    const { auth, db } = buildAuth({
      emailConfigured: false,
      signupOpen: true,
      appAdminAccess: true,
    });
    await bootstrapSignUp(auth, OWNER, issueBootstrapToken());
    const member = await signUp(auth, "member@example.com");
    const cookie = await sessionCookie(auth, OWNER);
    for (const data of [{ email: "new@example.com" }, { emailVerified: true }]) {
      const res = await post(auth, "/admin/update-user", cookie, { userId: member.user.id, data });
      expect(res.status).toBe(403);
    }
    const renamed = await post(auth, "/admin/update-user", cookie, {
      userId: member.user.id,
      data: { name: "Renamed" },
    });
    expect(renamed.status).toBe(200);
    expect(db.user.find((u) => (u as { id: string }).id === member.user.id)).toMatchObject({
      email: "member@example.com",
      name: "Renamed",
    });
  });

  it("refuses a user's own email change through /update-user", async () => {
    const { auth, db } = buildAuth({ emailConfigured: false, signupOpen: true, usersExist: true });
    const member = await signUp(auth, "member@example.com");
    const res = await post(auth, "/update-user", await sessionCookie(auth, "member@example.com"), {
      email: "new@example.com",
    });
    expect(res.status).toBe(400);
    expect(db.user.find((u) => (u as { id: string }).id === member.user.id)).toMatchObject({
      email: "member@example.com",
    });
  });
});
