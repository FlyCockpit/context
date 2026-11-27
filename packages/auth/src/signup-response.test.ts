vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import { describe, expect, it, vi } from "vitest";

// `/sign-up/email` must not tell a free address from a registered one. This
// runs the PRODUCTION auth instance (./index.ts: user fields, plugins,
// requireEmailVerification, hooks, database hooks) through its real HTTP
// handler, with only import IO replaced: Better-Auth's in-memory adapter
// stands in for Prisma's auth adapter, and the direct Prisma reads (the real
// signup-availability cache, the mail locale lookup) are counted stubs. Every
// sign-up pays a real scrypt hash, hence the roomier timeout.
const state = vi.hoisted(() => ({
  emailConfigured: true,
  // The admin's `signupOpen` AppSetting value (null = never set = open).
  signupSetting: null as string | null,
  settingReads: 0,
  db: { user: [], account: [], session: [], verification: [] } as Record<
    string,
    Record<string, unknown>[]
  >,
  // Every adapter call, including the ones made on the adapter a transaction
  // callback receives, so a test can prove two outcomes cost the same
  // database work (a conditional lookup is a timing oracle).
  adapterOps: [] as string[],
  // Runs once on the next user lookup: a point inside the sign-up, after the
  // before hook and before user creation.
  onNextUserLookup: null as null | (() => void),
}));

vi.mock("@cockpit-context/db", () => ({
  default: {
    user: {
      findUnique: async () => null,
      findFirst: async () => (state.db.user?.[0] ? { id: state.db.user[0].id } : null),
      findMany: async () => [],
    },
    account: {
      findFirst: async ({ where }: { where: { userId: string; providerId: string } }) =>
        state.db.account?.find(
          (row) => row.userId === where.userId && row.providerId === where.providerId,
        ) ?? null,
    },
    appSetting: {
      findUnique: async () => {
        state.settingReads += 1;
        return state.signupSetting === null ? null : { value: state.signupSetting };
      },
    },
  },
}));
vi.mock("@cockpit-context/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    NODE_ENV: "test",
  },
  ADMIN_EMAILS: new Set<string>(["owner@example.test"]),
  FORCE_SSO: false,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
}));
vi.mock("@cockpit-context/mailer", () => ({
  isEmailConfigured: () => state.emailConfigured,
  queueEmail: vi.fn(),
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: () => ({ subject: "Verify", html: "<p>verify</p>" }),
  sendEmail: vi.fn(async () => {}),
}));
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const recording = <A extends object>(adapter: A): A =>
    new Proxy(adapter, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const [first] = args;
          const model =
            typeof first === "object" && first !== null && "model" in first ? first.model : "";
          state.adapterOps.push(`${String(key)}:${String(model)}`);
          if (key === "findOne" && model === "user" && state.onNextUserLookup) {
            const run = state.onNextUserLookup;
            state.onNextUserLookup = null;
            run();
          }
          if (key === "transaction" && typeof first === "function") {
            args[0] = (trx: object) => first(recording(trx));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  const memory = memoryAdapter(state.db);
  return {
    prismaAdapter: () => (options: Parameters<typeof memory>[0]) => {
      const inner = memory(options);
      // Match production's nontransactional Prisma adapter: global Prisma
      // credential/locale reads see every write immediately.
      const adapter: typeof inner = new Proxy(inner, {
        get(target, key, receiver) {
          if (key === "transaction") return (work: (tx: typeof inner) => unknown) => work(adapter);
          return Reflect.get(target, key, receiver);
        },
      });
      return recording(adapter);
    },
  };
});

const NEUTRAL = '{"token":null,"user":null}';

const SEED_ADMIN_EMAIL = "seed-admin@example.test";

/**
 * `firstAccount`: start with no account at all (the first-admin bootstrap).
 * Otherwise the administrator already exists, as open sign-up requires
 * (./user-creation-policy.ts admits only the bootstrap as the first account).
 */
async function loadAuth(opts: { emailConfigured: boolean; firstAccount?: boolean }) {
  for (const rows of Object.values(state.db)) rows.length = 0;
  if (!opts.firstAccount) {
    const now = new Date();
    state.db.user?.push({
      id: "seed-admin",
      email: SEED_ADMIN_EMAIL,
      name: "Admin",
      emailVerified: true,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
  }
  state.emailConfigured = opts.emailConfigured;
  state.signupSetting = null;
  // A fresh module graph so `emailConfigured` (read at import) takes effect,
  // and so the creation-grant helpers below are the instances the auth uses.
  vi.resetModules();
  const { auth } = await import("./index");
  const { runWithAllowedUserCreation } = await import("./user-creation-policy");
  const { issueBootstrapToken, revokeBootstrapToken } = await import("./bootstrap-token");
  const { invalidateSignupAvailabilityCache, isSignupOpen } = await import("./signup-availability");
  revokeBootstrapToken();
  // What the server's signupAvailabilityGate leaves behind before every
  // sign-up: a warm availability cache.
  const warmGate = async () => {
    invalidateSignupAvailabilityCache();
    await isSignupOpen();
  };
  const closeSignup = () => {
    state.signupSetting = "false";
  };

  const signUp = async (email: string) => {
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ name: "Same Name", email, password: "same-password-12345" }),
      }),
    );
    return {
      status: res.status,
      headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
      body: await res.text(),
    };
  };
  // What apps/server/src/signup-gate.ts does for a listed address carrying the header.
  const bootstrapSignUp = (email: string, token: string) =>
    runWithAllowedUserCreation("admin-bootstrap", () => signUp(email), { bootstrapToken: token });
  // Runs one sign-up behind a freshly warmed gate cache and records the work
  // it did: auth-adapter calls and AppSetting reads.
  const measured = async <T>(fn: () => Promise<T>) => {
    await warmGate();
    const ops = state.adapterOps.length;
    const reads = state.settingReads;
    const result = await fn();
    return {
      result,
      ops: state.adapterOps.slice(ops),
      settingReads: state.settingReads - reads,
    };
  };
  const emails = () =>
    (state.db.user ?? [])
      .map((u) => u.email)
      .filter((email) => email !== SEED_ADMIN_EMAIL)
      .sort();
  // An admin closing sign-up (settings.update writes, then invalidates the
  // cache) while the next sign-up is already past its before hook.
  const closeSignupMidRequest = () => {
    state.onNextUserLookup = () => {
      closeSignup();
      invalidateSignupAvailabilityCache();
    };
  };
  return {
    signUp,
    bootstrapSignUp,
    measured,
    closeSignup,
    closeSignupMidRequest,
    issueBootstrapToken,
    emails,
  };
}

describe("sign-up response is the same for free and registered addresses", {
  timeout: 30_000,
}, () => {
  it("answers a new and an existing address byte-identically (SMTP, open sign-up)", async () => {
    const { signUp, measured, emails } = await loadAuth({ emailConfigured: true });
    await signUp("taken-verified@example.test");
    await signUp("taken-unverified@example.test");
    const verified = state.db.user?.find((u) => u.email === "taken-verified@example.test");
    if (!verified) throw new Error("seed user missing");
    verified.emailVerified = true;

    const { result: fresh, settingReads } = await measured(() => signUp("fresh@example.test"));
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(NEUTRAL);
    expect(fresh.headers.map(([name]) => name)).not.toContain("set-cookie");
    const takenVerified = await measured(() => signUp("taken-verified@example.test"));
    expect(takenVerified.result).toEqual(fresh);
    expect((await measured(() => signUp("taken-unverified@example.test"))).result).toEqual(fresh);
    // The hooks add no read that only one outcome pays: creating the free
    // account invalidates the availability cache, so a read after it would
    // reach the database for a free address and not for a registered one.
    expect(settingReads).toBe(0);
    expect(takenVerified.settingReads).toBe(settingReads);
    // The new address really got an account; the duplicates did not get a second one.
    expect(emails()).toEqual([
      "fresh@example.test",
      "taken-unverified@example.test",
      "taken-verified@example.test",
    ]);
    expect(state.db.user?.find((u) => u.email === "fresh@example.test")?.role).toBe("user");
  });

  it("with sign-up closed, rejects a registered address exactly like a free one", async () => {
    const { signUp, measured, closeSignup, emails } = await loadAuth({ emailConfigured: true });
    await signUp("taken@example.test");
    // The server's availability gate normally refuses before Better-Auth once
    // an account exists; this pins the auth package's own second line.
    closeSignup();
    const fresh = await measured(() => signUp("fresh@example.test"));
    expect(fresh.result.status).toBe(422);
    expect(JSON.parse(fresh.result.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
    const taken = await measured(() => signUp("taken@example.test"));
    expect(taken.result).toEqual(fresh.result);
    // Same database work too: no lookup only a registered address pays for.
    expect(fresh.ops).toContain("findOne:user");
    expect(taken.ops).toEqual(fresh.ops);
    expect(taken.settingReads).toBe(fresh.settingReads);
    expect(emails()).toEqual(["taken@example.test"]);
  });

  it("lets only a real first-admin bootstrap answer 200 while sign-up is closed", async () => {
    const { signUp, bootstrapSignUp, closeSignup, issueBootstrapToken, emails } = await loadAuth({
      emailConfigured: true,
      firstAccount: true,
    });
    closeSignup();
    const token = issueBootstrapToken();
    const stranger = await signUp("stranger@example.test");
    expect(stranger.status).toBe(422);

    const bootstrap = await bootstrapSignUp("owner@example.test", token);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toBe(NEUTRAL);
    expect(state.db.user?.find((u) => u.email === "owner@example.test")?.role).toBe("admin");
    // The same address again (now registered, token spent) answers the 422 a
    // free address gets: neither its registration nor its listing shows.
    expect(await bootstrapSignUp("owner@example.test", token)).toEqual(stranger);
    expect(await signUp("owner@example.test")).toEqual(stranger);
    expect(emails()).toEqual(["owner@example.test"]);
  });

  it("stays address-independent when sign-up closes mid-request", async () => {
    const { signUp, closeSignupMidRequest, emails } = await loadAuth({ emailConfigured: true });
    await signUp("taken@example.test");
    closeSignupMidRequest();
    const fresh = await signUp("fresh@example.test");
    state.signupSetting = null;
    closeSignupMidRequest();
    const taken = await signUp("taken@example.test");
    // Both decided on the request-start snapshot (open): the creation hook
    // agrees with the response normalization.
    expect(fresh.status).toBe(200);
    expect(taken).toEqual(fresh);
    expect(emails()).toEqual(["fresh@example.test", "taken@example.test"]);
  });

  it("refuses a wrong-token first sign-up with open sign-up exactly like any other address", async () => {
    const { signUp, bootstrapSignUp, issueBootstrapToken, emails } = await loadAuth({
      emailConfigured: true,
      firstAccount: true,
    });
    const token = issueBootstrapToken();
    // The server marker sets no bootstrap mode for a wrong token, so the
    // listed address arrives exactly like a stranger: same refusal.
    const listed = await signUp("owner@example.test");
    expect(listed.status).toBe(422);
    expect(JSON.parse(listed.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
    expect(await signUp("stranger@example.test")).toEqual(listed);
    expect(emails()).toEqual([]);
    // Nothing was created, so the bootstrap is still open.
    expect((await bootstrapSignUp("owner@example.test", token)).status).toBe(200);
    expect(state.db.user?.find((u) => u.email === "owner@example.test")?.role).toBe("admin");
  });

  it("leaves the no-SMTP sign-up alone: it signs the new account in", async () => {
    const { signUp } = await loadAuth({ emailConfigured: false });
    const fresh = await signUp("fresh@example.test");
    expect(fresh.status).toBe(200);
    // The web form reads `data.token` to go straight to the app.
    expect(JSON.parse(fresh.body)).toMatchObject({ token: expect.any(String) });
  });
});
