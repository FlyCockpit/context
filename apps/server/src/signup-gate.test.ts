import {
  BOOTSTRAP_TOKEN_HEADER,
  issueBootstrapToken,
  revokeBootstrapToken,
  verifyBootstrapToken,
} from "@cockpit-context/auth/bootstrap-token";
import type { SignupAvailability } from "@cockpit-context/auth/signup-availability";
import {
  decideUserCreation,
  getAllowedUserCreationMode,
  getBootstrapTokenCandidate,
  SIGNUP_DISABLED_MESSAGE,
} from "@cockpit-context/auth/user-creation-policy";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adminBootstrapMarker, signupAvailabilityGate } from "./signup-gate.js";

const PATH = "/api/auth/sign-up/email";
const ADMIN = "admin@example.com";
const MEMBER_SET = new Set([ADMIN]);

// Observed better-auth 1.7.1 `signUpEmail` behavior for the cases that matter
// here (better-auth/dist/api/routes/sign-up.mjs): input validation first
// (400s), then the existing-email generic duplicate (200, because
// requireEmailVerification is on), then createUser — where the database hook
// rejects with a plain Error that the route converts to 422
// FAILED_TO_CREATE_USER. member signups that clear the hook succeed (200).
// The stub below replays exactly that order, using the REAL decision function
// the hook delegates to, so the suite pins the wiring contract:
// every rejection must be identical for member and non-member addresses.
// The hook's `usersExist` read is modelled by `accounts`: an account created
// here closes the bootstrap and spends the token, as the auth `create.after`
// hook does.
function buildApp(opts: {
  signupEnabled: boolean;
  existingEmails?: Set<string>;
  emailConfigured?: boolean;
}) {
  // Default: the SMTP-configured template path (generic duplicate response).
  const emailConfigured = opts.emailConfigured ?? true;
  const accounts = new Set(opts.existingEmails ?? []);
  const app = new Hono();
  const seenModes: Array<string | undefined> = [];
  app.use(PATH, adminBootstrapMarker(MEMBER_SET));
  app.post(PATH, async (c) => {
    seenModes.push(getAllowedUserCreationMode());
    const body = (await c.req.json()) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ code: "INVALID_EMAIL", message: "Invalid email" }, 400);
    }
    if (password.length < 12) {
      return c.json({ code: "PASSWORD_TOO_SHORT", message: "Password is too short" }, 400);
    }
    if (accounts.has(email)) {
      return c.json({ token: null, user: { email } }, 200);
    }
    const creationMode = getAllowedUserCreationMode();
    const decision = decideUserCreation({
      signupOpen: opts.signupEnabled,
      creationMode,
      isAdminEmail: MEMBER_SET.has(email),
      emailConfigured,
      usersExist: accounts.size > 0,
      bootstrapTokenValid:
        creationMode === "admin-bootstrap" && verifyBootstrapToken(getBootstrapTokenCandidate()),
    });
    if (!decision.allowed) {
      return c.json({ code: "FAILED_TO_CREATE_USER", message: "Failed to create user" }, 422);
    }
    accounts.add(email);
    revokeBootstrapToken();
    return c.json({ token: "session-token", user: { email, role: decision.role ?? "user" } }, 200);
  });
  return { app, seenModes, accounts };
}

function post(app: Hono, body: unknown, token?: string) {
  return app.request(PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { [BOOTSTRAP_TOKEN_HEADER]: token }),
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  revokeBootstrapToken();
});

describe("adminBootstrapMarker", () => {
  it("queues member and non-member signups alike, so queueing reveals nothing", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const app = new Hono();
    app.use(PATH, adminBootstrapMarker(MEMBER_SET));
    app.post(PATH, async (c) => {
      const body = (await c.req.json()) as { email: string };
      order.push(`start:${body.email}`);
      if (body.email === "first@example.com") await firstBlocked;
      order.push(`end:${body.email}`);
      return c.json({ ok: true });
    });
    // A non-member request holds the queue; a member request must wait for it,
    // and so must another non-member: the wait never depends on membership.
    const first = post(app, { email: "first@example.com", password: "x".repeat(12) });
    const member = post(app, { email: ADMIN, password: "x".repeat(12) });
    const other = post(app, { email: "other@example.com", password: "x".repeat(12) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["start:first@example.com"]);
    releaseFirst();
    await Promise.all([first, member, other]);
    expect(order).toEqual([
      "start:first@example.com",
      "end:first@example.com",
      `start:${ADMIN}`,
      `end:${ADMIN}`,
      "start:other@example.com",
      "end:other@example.com",
    ]);
  });

  it("never responds itself — member, non-member, and malformed bodies all reach downstream", async () => {
    const { app, seenModes } = buildApp({ signupEnabled: false });
    for (const body of [
      { email: ADMIN, password: "long-enough-password" },
      { email: "stranger@example.com", password: "long-enough-password" },
      { notEmail: true },
    ]) {
      const res = await post(app, body);
      // Every response below comes from downstream, never from the marker:
      // the marker must not emit (or throw) for any body shape.
      expect([200, 400, 422]).toContain(res.status);
    }
    expect(seenModes).toHaveLength(3);
  });

  it("marks only member requests carrying the bootstrap token", async () => {
    const token = issueBootstrapToken();
    const { app, seenModes } = buildApp({ signupEnabled: false });
    await post(app, { email: ADMIN, password: "long-enough-password" }); // no token
    await post(app, { email: ADMIN, password: "long-enough-password" }, "wrong-token");
    await post(app, { email: "stranger@example.com", password: "long-enough-password" }, token);
    await post(app, { email: ADMIN, password: "long-enough-password" }, token);
    expect(seenModes).toEqual([undefined, undefined, undefined, "admin-bootstrap"]);
  });

  it("passes the body through un-consumed (downstream reads it, as auth.handler does)", async () => {
    const token = issueBootstrapToken();
    const { app } = buildApp({ signupEnabled: false });
    const res = await post(app, { email: ADMIN, password: "long-enough-password" }, token);
    expect(await res.json()).toEqual({
      token: "session-token",
      user: { email: ADMIN, role: "admin" },
    });
  });
});

describe.each([true, false])(
  "first-admin bootstrap token (SMTP configured: %s)",
  (emailConfigured) => {
    const VALID_MEMBER = { email: ADMIN, password: "long-enough-password" };

    it("with no account, a listed address plus the token becomes admin", async () => {
      const token = issueBootstrapToken();
      const { app } = buildApp({ signupEnabled: false, emailConfigured });
      const res = await post(app, VALID_MEMBER, token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ user: { role: "admin" } });
    });

    it("a guessed listed address without the token (or with a wrong one) is refused like any other", async () => {
      issueBootstrapToken();
      const { app, accounts } = buildApp({ signupEnabled: false, emailConfigured });
      const guessed = await post(app, VALID_MEMBER);
      const wrong = await post(app, VALID_MEMBER, "a".repeat(43));
      const stranger = await post(app, { email: "stranger@example.com", password: "x".repeat(20) });
      for (const res of [guessed, wrong, stranger]) expect(res.status).toBe(422);
      const bodies = await Promise.all([guessed, wrong, stranger].map((res) => res.json()));
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(accounts.size).toBe(0);
    });

    it("once one account exists the token admits nobody, even a listed address", async () => {
      const token = issueBootstrapToken();
      const { app } = buildApp({
        signupEnabled: false,
        emailConfigured,
        existingEmails: new Set(["someone@example.com"]),
      });
      const res = await post(app, VALID_MEMBER, token);
      expect(res.status).toBe(422);
    });

    it("the token cannot be reused for a second admin", async () => {
      const token = issueBootstrapToken();
      const { app, accounts } = buildApp({ signupEnabled: false, emailConfigured });
      expect((await post(app, VALID_MEMBER, token)).status).toBe(200);
      const second = await post(
        app,
        { email: "other-admin@example.com", password: "x".repeat(20) },
        token,
      );
      expect(second.status).toBe(422);
      expect(accounts).toEqual(new Set([ADMIN]));
    });

    it("a restart replaces the token: the previous boot's token stops working", async () => {
      const before = issueBootstrapToken();
      const after = issueBootstrapToken(); // the next boot
      const { app } = buildApp({ signupEnabled: false, emailConfigured });
      expect((await post(app, VALID_MEMBER, before)).status).toBe(422);
      expect((await post(app, VALID_MEMBER, after)).status).toBe(200);
    });
  },
);

describe("signup-disabled oracle — member vs non-member responses are indistinguishable", () => {
  const VALID_MEMBER = { email: ADMIN, password: "long-enough-password" };
  const VALID_NON_MEMBER = { email: "stranger@example.com", password: "long-enough-password" };

  it("invalid input yields identical 400s before any membership decision", async () => {
    const { app } = buildApp({ signupEnabled: false });
    const memberRes = await post(app, { email: ADMIN, password: "short" });
    const nonMemberRes = await post(app, { email: "stranger@example.com", password: "short" });
    expect(memberRes.status).toBe(nonMemberRes.status);
    expect(await memberRes.json()).toEqual(await nonMemberRes.json());
    expect(memberRes.status).toBe(400);
  });

  it("blocked signups yield identical 422s for different non-member addresses", async () => {
    const { app } = buildApp({ signupEnabled: false });
    const a = await post(app, VALID_NON_MEMBER);
    const b = await post(app, { email: "other@example.com", password: "another-long-password" });
    const aBody = (await a.json()) as Record<string, unknown>;
    const bBody = (await b.json()) as Record<string, unknown>;
    expect(a.status).toBe(422);
    expect(aBody).toEqual(bBody);
    expect(Object.keys(aBody).sort()).toEqual(["code", "message"]);
  });

  it("already-registered emails yield identical generic 200s for member and non-member", async () => {
    const { app } = buildApp({
      signupEnabled: false,
      existingEmails: new Set([ADMIN, "stranger@example.com"]),
    });
    const memberRes = await post(app, VALID_MEMBER);
    const nonMemberRes = await post(app, VALID_NON_MEMBER);
    const memberBody = (await memberRes.json()) as Record<string, unknown>;
    const nonMemberBody = (await nonMemberRes.json()) as Record<string, unknown>;
    expect(memberRes.status).toBe(200);
    expect(nonMemberRes.status).toBe(200);
    // Same status + same body keys. The echoed `email` value necessarily
    // differs (it is the caller-supplied address, which Better-Auth reflects
    // back) — that is not membership information.
    expect(Object.keys(memberBody).sort()).toEqual(Object.keys(nonMemberBody).sort());
    expect(memberBody.token).toBe(nonMemberBody.token);
  });

  it("without the boot-log token a valid NEW member signup is refused exactly like a non-member", async () => {
    issueBootstrapToken();
    const { app } = buildApp({ signupEnabled: false });
    const memberRes = await post(app, VALID_MEMBER);
    const nonMemberRes = await post(app, VALID_NON_MEMBER);
    expect(memberRes.status).toBe(422);
    expect(nonMemberRes.status).toBe(422);
    expect(await memberRes.json()).toEqual(await nonMemberRes.json());
  });

  it("documents the one necessary divergence: the token holder's listed address succeeds", async () => {
    const token = issueBootstrapToken();
    const { app } = buildApp({ signupEnabled: false });
    const memberRes = await post(app, VALID_MEMBER, token);
    const nonMemberRes = await post(app, VALID_NON_MEMBER, token);
    expect(memberRes.status).toBe(200);
    expect(nonMemberRes.status).toBe(422);
    // Only someone holding the boot-log token can observe this split, and that
    // person is the operator who set ADMIN_EMAILS.
  });
});

describe("signupAvailabilityGate — request-independent closed-server refusal", () => {
  function buildGatedApp(availability: SignupAvailability) {
    const app = new Hono();
    const downstream = vi.fn();
    const getAvailability = vi.fn(async () => availability);
    app.use(PATH, adminBootstrapMarker(MEMBER_SET));
    app.use(PATH, signupAvailabilityGate(getAvailability));
    app.post(PATH, (c) => {
      downstream();
      return c.json({ token: "session-token" }, 200);
    });
    return { app, downstream, getAvailability };
  }

  it("refuses every address identically when neither signup nor bootstrap is open", async () => {
    const { app, downstream } = buildGatedApp({
      signupOpen: false,
      adminBootstrapOpen: false,
      adminSetup: null,
    });
    const responses = await Promise.all(
      [
        { email: ADMIN, password: "long-enough-password" },
        { email: "stranger@example.com", password: "long-enough-password" },
        { notEmail: true },
      ].map((body) => post(app, body)),
    );
    const bodies = await Promise.all(responses.map((res) => res.json()));
    for (const res of responses) expect(res.status).toBe(403);
    // Same body for a listed address, an unlisted one and garbage: no
    // membership oracle, and no "already exists" enumeration either.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ code: "SIGNUP_DISABLED", message: SIGNUP_DISABLED_MESSAGE });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("falls through to Better-Auth while open signup is available", async () => {
    const { app, downstream } = buildGatedApp({
      signupOpen: true,
      adminBootstrapOpen: false,
      adminSetup: null,
    });
    const res = await post(app, {
      email: "stranger@example.com",
      password: "long-enough-password",
    });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("falls through for every address while only the bootstrap is open (the hook decides)", async () => {
    const { app, downstream } = buildGatedApp({
      signupOpen: false,
      adminBootstrapOpen: true,
      adminSetup: "bootstrap",
    });
    await post(app, { email: ADMIN, password: "long-enough-password" });
    await post(app, { email: "stranger@example.com", password: "long-enough-password" });
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it("never reads the request to decide (availability is fetched without arguments)", async () => {
    const { app, getAvailability } = buildGatedApp({
      signupOpen: false,
      adminBootstrapOpen: false,
      adminSetup: null,
    });
    await post(app, { email: ADMIN, password: "long-enough-password" });
    expect(getAvailability).toHaveBeenCalledWith();
  });
});
