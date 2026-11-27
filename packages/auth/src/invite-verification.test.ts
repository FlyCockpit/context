import { createHash } from "node:crypto";
import { BASE_ERROR_CODES, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResetLinkHooks,
  createSetPasswordToken,
  deleteOtherResetLinks,
  isResetLinkRedeemable,
  recordResetLinkMailed,
  resetTokenOf,
  verifyEmailIfResetLinkWasMailed,
} from "./invite-verification";

// The REAL Better-Auth reset endpoint (in-memory adapter, no SMTP) consuming a
// token minted the way `users.invite` and `users.passwordLink` mint it.
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
describe("set-password token (Better-Auth reset)", () => {
  const OLD_PASSWORD = "original-password-123";
  const NEW_PASSWORD = "chosen-password-456";

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const memory: Record<string, unknown[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
    };
    const auth = betterAuth({
      database: memoryAdapter(memory),
      secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
      baseURL: "http://localhost:3000",
      logger: { disabled: true },
      rateLimit: { enabled: false },
      emailAndPassword: { enabled: true, minPasswordLength: 12, password: fastPassword },
    });
    const alice = await auth.api.signUpEmail({
      body: { email: "alice@example.com", password: OLD_PASSWORD, name: "Alice" },
    });
    const bob = await auth.api.signUpEmail({
      body: { email: "bob@example.com", password: OLD_PASSWORD, name: "Bob" },
    });
    const ctx = await auth.$context;
    const mint = (userId: string, ttlMs = 7 * 24 * 60 * 60 * 1000) =>
      createSetPasswordToken(ctx.internalAdapter, userId, new Date(Date.now() + ttlMs));
    const reset = (token: string, newPassword = NEW_PASSWORD) =>
      auth.api.resetPassword({ body: { token, newPassword } });
    const signIn = (email: string, password: string) =>
      auth.api.signInEmail({ body: { email, password } });
    return { auth, alice: alice.user, bob: bob.user, mint, reset, signIn };
  }

  it("sets the password of the user it is bound to, and nobody else's", async () => {
    const { alice, mint, reset, signIn } = await setup();
    const token = await mint(alice.id);
    await expect(reset(token)).resolves.toMatchObject({ status: true });
    await expect(signIn("alice@example.com", NEW_PASSWORD)).resolves.toMatchObject({
      user: { id: alice.id },
    });
    await expect(signIn("bob@example.com", NEW_PASSWORD)).rejects.toThrow();
    await expect(signIn("bob@example.com", OLD_PASSWORD)).resolves.toBeTruthy();
  });

  it("works once: a reused link is refused", async () => {
    const { alice, mint, reset, signIn } = await setup();
    const token = await mint(alice.id);
    await reset(token);
    await expect(reset(token, "attacker-password-789")).rejects.toThrow(/invalid token/i);
    await expect(signIn("alice@example.com", "attacker-password-789")).rejects.toThrow();
  });

  it("is refused once it has expired", async () => {
    const { alice, mint, reset, signIn } = await setup();
    const token = await mint(alice.id, 60_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await expect(reset(token)).rejects.toThrow(/invalid token/i);
    vi.useRealTimers();
    await expect(signIn("alice@example.com", OLD_PASSWORD)).resolves.toBeTruthy();
  });

  it("writes a reset-password row whose value is the user id", async () => {
    const createVerificationValue = vi.fn(async () => ({}));
    const expiresAt = new Date("2026-11-19T00:00:00Z");
    const token = await createSetPasswordToken({ createVerificationValue }, "u1", expiresAt);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(createVerificationValue).toHaveBeenCalledWith({
      identifier: `reset-password:${token}`,
      value: "u1",
      expiresAt,
    });
  });
});

const mailedId = (token: string) =>
  `reset-password-mailed:${createHash("sha256").update(token).digest("base64url")}`;

describe("set-password link rules (adapter level)", () => {
  const NOW = new Date("2026-11-20T00:00:00Z");
  const LATER = new Date("2026-11-27T00:00:00Z");
  type Row = { value: string; expiresAt: Date };

  function fakeAdapter(opts: {
    rows: Record<string, Row>;
    user?: { email: string; emailVerified: boolean } | null;
    accounts?: Array<{ providerId: string }>;
    sessions?: unknown[];
  }) {
    const rows = { ...opts.rows };
    return {
      rows,
      createVerificationValue: vi.fn(async (row: { identifier: string } & Row) => {
        rows[row.identifier] = { value: row.value, expiresAt: row.expiresAt };
      }),
      findVerificationValue: vi.fn(async (identifier: string) => rows[identifier] ?? null),
      consumeVerificationValue: vi.fn(async (identifier: string) => {
        const row = rows[identifier] ?? null;
        delete rows[identifier];
        return row;
      }),
      findUserById: vi.fn(async () =>
        opts.user === undefined ? { email: "new@example.com", emailVerified: false } : opts.user,
      ),
      updateUser: vi.fn(async () => ({})),
      findAccounts: vi.fn(async () => opts.accounts ?? [{ providerId: "credential" }]),
      listSessions: vi.fn(async () => opts.sessions ?? []),
    };
  }
  const link = (token: string, expiresAt = LATER) => ({
    [`reset-password:${token}`]: { value: "u1", expiresAt },
  });
  const mailed = (token: string, value: unknown, expiresAt = LATER) => ({
    [mailedId(token)]: {
      value: typeof value === "string" ? value : JSON.stringify(value),
      expiresAt,
    },
  });
  const redeemable = (
    adapter: ReturnType<typeof fakeAdapter>,
    token = "t",
    emailConfigured = true,
  ) => isResetLinkRedeemable(adapter, token, { emailConfigured, now: NOW });

  it("records a mailed link per token (hash only), bound to the user and the lowercased address, with the link's expiry", async () => {
    const adapter = fakeAdapter({ rows: link("t") });
    await expect(
      recordResetLinkMailed(adapter, { token: "t", email: "New@Example.com" }, NOW),
    ).resolves.toBe(true);
    expect(adapter.createVerificationValue).toHaveBeenCalledWith({
      identifier: mailedId("t"),
      value: JSON.stringify({ userId: "u1", email: "new@example.com" }),
      expiresAt: LATER,
    });
  });

  it("records nothing for a link that is gone or expired", async () => {
    const adapter = fakeAdapter({ rows: link("old", NOW) });
    for (const token of ["missing", "old"]) {
      await expect(recordResetLinkMailed(adapter, { token, email: "a@b.c" }, NOW)).resolves.toBe(
        false,
      );
    }
    expect(adapter.createVerificationValue).not.toHaveBeenCalled();
  });

  it("lets a mailed link be spent in any account state", async () => {
    const adapter = fakeAdapter({
      rows: { ...link("t"), ...mailed("t", { userId: "u1", email: "new@example.com" }) },
      user: { email: "new@example.com", emailVerified: true },
      sessions: [{ id: "s1" }],
    });
    await expect(redeemable(adapter)).resolves.toBe(true);
    expect(adapter.findUserById).not.toHaveBeenCalled();
  });

  it("lets a pending invitee spend a link that was only shown", async () => {
    const adapter = fakeAdapter({ rows: link("t") });
    await expect(redeemable(adapter)).resolves.toBe(true);
  });

  it.each([
    ["verified", { user: { email: "new@example.com", emailVerified: true } }],
    ["linked to an IdP", { accounts: [{ providerId: "credential" }, { providerId: "sso" }] }],
    ["signed in", { sessions: [{ id: "s1" }] }],
    ["gone", { user: null }],
  ])("refuses a shown link once the account is %s, on every try", async (_label, state) => {
    const adapter = fakeAdapter({ rows: link("t"), ...state });
    await expect(redeemable(adapter)).resolves.toBe(false);
    await expect(redeemable(adapter)).resolves.toBe(false);
    // Left to expire: deleting it would gain nothing and could kill a link
    // whose mailed record was still being written.
    expect(adapter.rows).toEqual(link("t"));
  });

  it("lets a link through once its mailed record committed after an early refused try", async () => {
    const adapter = fakeAdapter({
      rows: link("t"),
      user: { email: "new@example.com", emailVerified: true },
    });
    await expect(redeemable(adapter)).resolves.toBe(false);
    await recordResetLinkMailed(adapter, { token: "t", email: "new@example.com" }, NOW);
    await expect(redeemable(adapter)).resolves.toBe(true);
  });

  it.each([
    ["another user's", mailed("t", { userId: "u2", email: "new@example.com" })],
    ["an expired", mailed("t", { userId: "u1", email: "new@example.com" }, NOW)],
    ["a malformed", mailed("t", "not json")],
  ])("does not count %s mailed record", async (_label, record) => {
    const adapter = fakeAdapter({
      rows: { ...link("t"), ...record },
      user: { email: "new@example.com", emailVerified: true },
    });
    await expect(redeemable(adapter)).resolves.toBe(false);
  });

  it("leaves unknown and expired tokens to Better-Auth", async () => {
    const adapter = fakeAdapter({
      rows: link("old", NOW),
      user: { email: "x", emailVerified: true },
    });
    for (const token of ["missing", "old"])
      await expect(redeemable(adapter, token)).resolves.toBe(true);
    expect(adapter.findUserById).not.toHaveBeenCalled();
  });

  it("judges nothing without SMTP, where admins hand out links by design", async () => {
    const adapter = fakeAdapter({ rows: link("t"), user: { email: "x", emailVerified: true } });
    await expect(redeemable(adapter, "t", false)).resolves.toBe(true);
    expect(adapter.findVerificationValue).not.toHaveBeenCalled();
  });

  it("verifies the mailed address once, and only while it is still the user's", async () => {
    const record = mailed("t", { userId: "u1", email: "new@example.com" });
    const fresh = fakeAdapter({ rows: { ...record } });
    await expect(verifyEmailIfResetLinkWasMailed(fresh, "t", NOW)).resolves.toBe(true);
    expect(fresh.updateUser).toHaveBeenCalledWith("u1", { emailVerified: true });
    await expect(verifyEmailIfResetLinkWasMailed(fresh, "t", NOW)).resolves.toBe(false);
    expect(fresh.updateUser).toHaveBeenCalledOnce();

    const moved = fakeAdapter({
      rows: { ...record },
      user: { email: "other@example.com", emailVerified: false },
    });
    await expect(verifyEmailIfResetLinkWasMailed(moved, "t", NOW)).resolves.toBe(false);
    expect(moved.updateUser).not.toHaveBeenCalled();

    for (const rows of [
      {},
      mailed("t", "not json"),
      mailed("t", { userId: "u1", email: "new@example.com" }, NOW),
    ]) {
      const adapter = fakeAdapter({ rows });
      await expect(verifyEmailIfResetLinkWasMailed(adapter, "t", NOW)).resolves.toBe(false);
      expect(adapter.updateUser).not.toHaveBeenCalled();
    }
  });

  it("deletes every reset link of the user, nobody else's", async () => {
    const deleteMany = vi.fn(async () => 2);
    await deleteOtherResetLinks({ deleteMany }, "u1");
    expect(deleteMany).toHaveBeenCalledWith({
      model: "verification",
      where: [
        { field: "identifier", operator: "starts_with", value: "reset-password:" },
        { field: "value", value: "u1" },
      ],
    });
  });

  it("reads the token of a reset-password request only", () => {
    expect(resetTokenOf({ path: "/reset-password", body: { token: "b" } })).toBe("b");
    expect(resetTokenOf({ path: "/reset-password", body: {}, query: { token: "q" } })).toBe("q");
    expect(resetTokenOf({ path: "/reset-password", body: { token: "" } })).toBeNull();
    expect(resetTokenOf({ path: "/sign-in/email", body: { token: "b" } })).toBeNull();
  });
});

// The REAL Better-Auth endpoints (memory adapter) with the production wiring
// of packages/auth/src/index.ts: the same `createResetLinkHooks` in the
// before/after hooks, `sendResetPassword` and `onPasswordReset`.
describe("set-password links on the real endpoints", () => {
  const PASSWORD = "original-password-123";
  const NEW_PASSWORD = "chosen-password-456";

  async function setup(opts: { emailConfigured?: boolean; cleanupFails?: boolean } = {}) {
    const emailConfigured = opts.emailConfigured ?? true;
    type Row = Record<string, unknown>;
    const memory = {
      user: [] as Row[],
      session: [] as Row[],
      account: [] as Row[],
      verification: [] as Row[],
    };
    const hooks = createResetLinkHooks({ emailConfigured });
    const mailedTokens: string[] = [];
    const failingDeleter = {
      deleteMany: async () => {
        throw new Error("db down");
      },
    };
    const auth = betterAuth({
      database: memoryAdapter(memory),
      secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
      baseURL: "http://localhost:3000",
      logger: { disabled: true },
      rateLimit: { enabled: false },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        password: fastPassword,
        requireEmailVerification: emailConfigured,
        ...(emailConfigured
          ? {
              sendResetPassword: async ({
                user,
                token,
              }: {
                user: { email: string };
                token: string;
              }) => {
                mailedTokens.push(token);
                await hooks.afterResetMailSent((await auth.$context).internalAdapter, {
                  token,
                  email: user.email,
                });
              },
            }
          : {}),
        onPasswordReset: async ({ user }: { user: { id: string } }) => {
          await hooks.afterPasswordReset(
            opts.cleanupFails ? failingDeleter : (await auth.$context).adapter,
            user.id,
          );
        },
      },
      ...(emailConfigured
        ? { emailVerification: { sendVerificationEmail: async () => {}, sendOnSignUp: false } }
        : {}),
      hooks: {
        before: createAuthMiddleware(async (ctx) => hooks.before(ctx)),
        after: createAuthMiddleware(async (ctx) => hooks.after(ctx)),
      },
    });
    const { user } = await auth.api.signUpEmail({
      body: { email: "invitee@example.com", password: PASSWORD, name: "Invitee" },
    });
    const ctx = await auth.$context;
    const row = () => memory.user.find((u) => u.id === user.id);
    return {
      memory,
      ctx,
      user,
      row,
      mailedTokens,
      /** As users.invite / users.passwordLink mint: shown, or mailed (recorded after the send). */
      mint: async (delivery: "shown" | "mailed") => {
        const token = await createSetPasswordToken(
          ctx.internalAdapter,
          user.id,
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        );
        if (delivery === "mailed") {
          await recordResetLinkMailed(ctx.internalAdapter, { token, email: user.email });
        }
        return token;
      },
      reset: (token: string) =>
        auth.api.resetPassword({ body: { token, newPassword: NEW_PASSWORD } }),
      forgotPassword: () =>
        auth.api.requestPasswordReset({ body: { email: "invitee@example.com", redirectTo: "/" } }),
      passwordIs: (password: string) => {
        const account = memory.account.find((a) => a.userId === user.id);
        return fastPassword.verify({ hash: String(account?.password), password });
      },
      verify: () => ctx.internalAdapter.updateUser(user.id, { emailVerified: true }),
      resetLinks: () =>
        memory.verification.filter((v) => String(v.identifier).startsWith("reset-password:")),
    };
  }
  const refused = { body: { code: BASE_ERROR_CODES.INVALID_TOKEN.code } };

  it("a mailed invite link sets the password and verifies the address", async () => {
    const t = await setup();
    await expect(t.reset(await t.mint("mailed"))).resolves.toMatchObject({ status: true });
    expect(await t.passwordIs(NEW_PASSWORD)).toBe(true);
    expect(t.row()).toMatchObject({ emailVerified: true });
  });

  it("a shown invite link sets a pending invitee's password and verifies nothing", async () => {
    const t = await setup();
    await expect(t.reset(await t.mint("shown"))).resolves.toMatchObject({ status: true });
    expect(await t.passwordIs(NEW_PASSWORD)).toBe(true);
    expect(t.row()).toMatchObject({ emailVerified: false });
  });

  it("a shown link left over once the invitee verified another way is refused like an expired one", async () => {
    const t = await setup();
    const token = await t.mint("shown");
    await t.verify();
    await expect(t.reset(token)).rejects.toMatchObject(refused);
    await expect(t.reset(token)).rejects.toMatchObject(refused);
    expect(await t.passwordIs(PASSWORD)).toBe(true);
  });

  it("a shown link is refused once an IdP identity is linked", async () => {
    const t = await setup();
    const token = await t.mint("shown");
    await t.ctx.internalAdapter.linkAccount({
      providerId: "sso",
      accountId: "idp-1",
      userId: t.user.id,
    });
    await expect(t.reset(token)).rejects.toMatchObject(refused);
    expect(await t.passwordIs(PASSWORD)).toBe(true);
  });

  it("a shown link never redeems another link's mail, and spending it kills the other", async () => {
    // Both live at once (e.g. a password-link mail raced the invite whose mail failed).
    const t = await setup();
    const shown = await t.mint("shown");
    const mailedLink = await t.mint("mailed");
    await expect(t.reset(shown)).resolves.toMatchObject({ status: true });
    expect(t.row()).toMatchObject({ emailVerified: false });
    expect(t.resetLinks()).toEqual([]);
    await expect(t.reset(mailedLink)).rejects.toMatchObject(refused);
  });

  it("forgot-password verifies, and kills a shown invite link still outstanding", async () => {
    const t = await setup();
    const shown = await t.mint("shown");
    await t.forgotPassword();
    expect(t.mailedTokens).toHaveLength(1);
    await expect(t.reset(t.mailedTokens[0]!)).resolves.toMatchObject({ status: true });
    expect(t.row()).toMatchObject({ emailVerified: true });
    expect(t.resetLinks()).toEqual([]);
    await expect(t.reset(shown)).rejects.toMatchObject(refused);
  });

  it("a mailed link still works for an active account", async () => {
    const t = await setup();
    await t.verify();
    await t.forgotPassword();
    await expect(t.reset(t.mailedTokens[0]!)).resolves.toMatchObject({ status: true });
    expect(await t.passwordIs(NEW_PASSWORD)).toBe(true);
  });

  it("refuses a leftover shown link even when the cleanup after a reset failed", async () => {
    const t = await setup({ cleanupFails: true });
    const shown = await t.mint("shown");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.forgotPassword();
    await expect(t.reset(t.mailedTokens[0]!)).resolves.toMatchObject({ status: true });
    expect(error).toHaveBeenCalledWith(
      "[auth] deleting the user's other reset links failed:",
      "Error: db down",
    );
    error.mockRestore();
    expect(t.resetLinks()).toHaveLength(1);
    await expect(t.reset(shown)).rejects.toMatchObject(refused);
    expect(await t.passwordIs(NEW_PASSWORD)).toBe(true);
  });

  it("judges nothing without SMTP", async () => {
    const t = await setup({ emailConfigured: false });
    await t.verify();
    await expect(t.reset(await t.mint("shown"))).resolves.toMatchObject({ status: true });
    expect(await t.passwordIs(NEW_PASSWORD)).toBe(true);
  });
});
