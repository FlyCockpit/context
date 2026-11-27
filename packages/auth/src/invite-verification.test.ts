import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", () => ({ default: {} }));
vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

import { createSetPasswordToken } from "./invite-verification";

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
