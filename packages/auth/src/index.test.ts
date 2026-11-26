import { describe, expect, it, vi } from "vitest";

// The production `auth` instance, built with import IO mocked: this pins its
// wiring (the copies in banned-session-guard.test.ts exercise the behavior).
vi.mock("@cockpit-context/db", () => ({ default: {} }));
vi.mock("@cockpit-context/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    NODE_ENV: "test",
  },
  ADMIN_EMAILS: new Set<string>(),
  FORCE_SSO: false,
  SSO_ENABLED: false,
}));
vi.mock("@cockpit-context/mailer", () => ({
  isEmailConfigured: () => false,
  queueEmail: vi.fn(),
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

const { auth, passwordPepper } = await import("./index");
const { onUserBanned } = await import("./ban");

describe("production auth wiring", () => {
  it("uses the pepper for hashing and verifying passwords", () => {
    expect(auth.options.emailAndPassword?.password?.hash).toBe(passwordPepper.hash);
    expect(auth.options.emailAndPassword?.password?.verify).toBe(passwordPepper.verify);
  });
  it("registers the banned-session guard as the first plugin", () => {
    expect(auth.options.plugins?.[0]?.id).toBe("cockpit-context-banned-session-guard");
  });

  it("announces a ban written through Better-Auth's user update, and tolerates a vanished row", async () => {
    const after = auth.options.databaseHooks?.user?.update?.after;
    expect(after).toBeTypeOf("function");
    const announced: string[] = [];
    const stop = onUserBanned((userId) => announced.push(userId));
    try {
      const call = after as unknown as (user: unknown, ctx: unknown) => Promise<void>;
      await call({ id: "u-ok", banned: false }, null);
      await call({ id: "u-banned", banned: true, banExpires: null }, null);
      await expect(call(null, null)).resolves.toBeUndefined();
    } finally {
      stop();
    }
    expect(announced).toEqual(["u-banned"]);
  });
});
