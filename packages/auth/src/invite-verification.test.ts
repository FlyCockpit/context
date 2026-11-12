import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", () => ({
  default: {
    verification: { create: vi.fn(), deleteMany: vi.fn() },
    user: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const { default: prisma } = await import("@cockpit-context/db");
const {
  clearInviteEmailDelivered,
  createSetPasswordToken,
  recordInviteEmailDelivered,
  verifyInvitedEmailOnPasswordReset,
} = await import("./invite-verification");

const db = prisma as unknown as {
  verification: { create: MockInstance; deleteMany: MockInstance };
  user: { update: MockInstance };
  $transaction: MockInstance;
};

describe("invite email verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  });

  it("records the emailed invite against the user and the lowercased address", async () => {
    const expiresAt = new Date("2026-11-11T00:00:00Z");
    await recordInviteEmailDelivered({ userId: "u1", email: "New@Example.com", expiresAt });
    expect(db.verification.create).toHaveBeenCalledWith({
      data: { identifier: "invite-email-delivered:u1", value: "new@example.com", expiresAt },
    });
  });

  it("verifies the address when an unexpired marker for that address is consumed", async () => {
    db.verification.deleteMany.mockResolvedValue({ count: 1 });

    const verified = await verifyInvitedEmailOnPasswordReset({
      id: "u1",
      email: "New@Example.com",
    });

    expect(verified).toBe(true);
    const where = db.verification.deleteMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      identifier: "invite-email-delivered:u1",
      value: "new@example.com",
    });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { emailVerified: true },
    });
  });

  it("leaves the address unverified without a marker (copied link, ordinary reset, expired)", async () => {
    db.verification.deleteMany.mockResolvedValue({ count: 0 });

    const verified = await verifyInvitedEmailOnPasswordReset({
      id: "u1",
      email: "new@example.com",
    });

    expect(verified).toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("clears only the user's own marker", async () => {
    db.verification.deleteMany.mockResolvedValue({ count: 1 });
    await clearInviteEmailDelivered("u1");
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "invite-email-delivered:u1" },
    });
  });
});

// The REAL Better-Auth reset endpoint (in-memory adapter, no SMTP) consuming a
// token minted the way `users.invite` and `users.passwordLink` mint it.
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
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
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
