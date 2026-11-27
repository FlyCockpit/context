import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Actual pinned handler + production options, hooks and selective adapter.
// PostgreSQL and delivery are simulated here. scripts/test-runtime-operations.mjs
// owns migrated disposable PostgreSQL (pool max 3) for real lock-ordered spends,
// verify-email/IdP activation, consume rechecks, rollback/retry, MCP tombstones,
// and late session/challenge fences. SMTP delivery remains a fixture fact there.
const fixture = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const events: string[] = [];
  let connections = 0;
  const controls = { injectLateRows: false, failAfterCallback: false };
  let peak = 0;
  let lockBarrier: ((key: string) => Promise<void>) | undefined;
  let sessionSweepBarrier: (() => Promise<void>) | undefined;
  let readBarrier: ((where: Row) => void) | undefined;
  const match = (row: Row, where: Row): boolean =>
    Object.entries(where ?? {}).every(([key, value]) => {
      if (key === "user") {
        const related = tables.user?.find((item) => item.id === row.userId);
        return !!related && match(related, value as Row);
      }
      if (key === "OR") return (value as Row[]).some((condition) => match(row, condition));
      const have = row[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const condition = value as Row;
        if ("startsWith" in condition && !String(have).startsWith(String(condition.startsWith)))
          return false;
        if ("not" in condition && have === condition.not) return false;
        if (
          "gt" in condition &&
          !(have instanceof Date && condition.gt instanceof Date && have > condition.gt)
        )
          return false;
        if ("in" in condition && !(condition.in as unknown[]).includes(have)) return false;
        return true;
      }
      return have === value;
    });
  const delegate = (name: string) => ({
    findFirst: async ({ where }: { where: Row }) => {
      readBarrier?.(where);
      return tables[name]?.find((row) => match(row, where)) ?? null;
    },
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = tables[name]?.find((item) => match(item, where));
      if (!row) return null;
      if (name !== "user") return row;
      return {
        ...row,
        accounts: (() => {
          const accounts = select?.accounts as { where?: Row; take?: number } | undefined;
          return (
            tables.account
              ?.filter(
                (account) => account.userId === row.id && match(account, accounts?.where ?? {}),
              )
              .slice(0, accounts?.take) ?? []
          );
        })(),
        sessions:
          tables.session
            ?.filter(
              (session) =>
                session.userId === row.id &&
                session.expiresAt instanceof Date &&
                session.expiresAt > new Date(),
            )
            .slice(0, 1) ?? [],
      };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...data };
      tables[name] ??= [];
      tables[name].push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = tables[name]?.filter((row) => match(row, where)) ?? [];
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      if (name === "session" && tables.account?.some((row) => row.providerId === "sso"))
        await sessionSweepBarrier?.();
      const rows = tables[name] ?? [];
      tables[name] = rows.filter((row) => !match(row, where));
      return { count: rows.length - tables[name].length };
    },
  });
  const client = {
    user: delegate("user"),
    account: delegate("account"),
    verification: delegate("verification"),
    session: delegate("session"),
    mcpAgentToken: delegate("mcpAgentToken"),
    mcpGrant: delegate("mcpGrant"),
    oauthAccessToken: delegate("oauthAccessToken"),
    oauthRefreshToken: delegate("oauthRefreshToken"),
    oauthConsent: delegate("oauthConsent"),
    appSetting: delegate("appSetting"),
    $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
      if (_sql.join("").includes("WITH challenges")) {
        const challenges = (tables.verification ?? []).filter(
          (row) => row.value === key && String(row.identifier).startsWith("2fa-"),
        );
        const identifiers = new Set(
          challenges.flatMap((row) => [
            row.identifier,
            `2fa-otp-${row.identifier}`,
            `2fa-attempts-${row.identifier}`,
          ]),
        );
        tables.verification = (tables.verification ?? []).filter(
          (row) =>
            !identifiers.has(row.identifier) &&
            !(row.value === key && String(row.identifier).startsWith("trust-device-")),
        );
      }
      events.push(key);
      if (key?.startsWith("password-write:")) await lockBarrier?.(key);
      return 1;
    },
    $queryRaw: async () => [{ locked: true }],
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (work: unknown) => {
    if (Array.isArray(work)) return Promise.all(work);
    connections++;
    peak = Math.max(peak, connections);
    const snapshot = structuredClone(tables);
    try {
      const result = await (work as (tx: typeof client) => Promise<unknown>)(client);
      if (
        controls.failAfterCallback &&
        snapshot.account?.some(
          (old) =>
            old.providerId === "credential" &&
            tables.account?.find((row) => row.id === old.id)?.password !== old.password,
        )
      ) {
        controls.failAfterCallback = false;
        throw new Error("fixture commit failure");
      }
      if (
        controls.injectLateRows &&
        tables.account?.some((row) => row.providerId === "sso") &&
        !snapshot.account?.some((row) => row.providerId === "sso")
      ) {
        controls.injectLateRows = false;
        tables.session!.push({ id: "before-commit", userId: "invitee" });
        tables.verification!.push({
          id: "late-2fa",
          identifier: "2fa-beforecommit",
          value: "invitee",
        });
      }
      return result;
    } catch (error) {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
      throw error;
    } finally {
      connections--;
    }
  });
  return {
    tables,
    client,
    events,
    match,
    controls,
    connections: () => connections,
    setSessionSweepBarrier: (fn?: typeof sessionSweepBarrier) => {
      sessionSweepBarrier = fn;
    },
    setLockBarrier: (fn?: typeof lockBarrier) => {
      lockBarrier = fn;
    },
    setReadBarrier: (fn?: typeof readBarrier) => {
      readBarrier = fn;
    },
    peak: () => peak,
  };
});
vi.mock("@cockpit-context/db", () => ({ default: fixture.client }));
vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/env/server", () => ({
  env: {
    NODE_ENV: "test",
    COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER: 20,
    BETTER_AUTH_URL: "https://app.example.test",
    BETTER_AUTH_SECRET: "disposable-activation-fixture-secret-123456789",
  },
  ADMIN_EMAILS: new Set(),
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@cockpit-context/mailer", () => ({
  INTERACTIVE_EMAIL_DELIVERY: {},
  isEmailConfigured: () => true,
  queueEmail: vi.fn(),
  renderResetPassword: () => ({ subject: "Reset", html: "" }),
  renderVerifyEmail: () => ({ subject: "Verify", html: "" }),
  renderTwoFactorOtp: () => ({ subject: "OTP", html: "" }),
  sendEmail: async () => {
    expect(fixture.connections()).toBe(0);
  },
}));
vi.mock("./mcp-plugins", () => ({ resolveMcpPlugins: () => [] }));
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { prismaAdapter: () => memoryAdapter(fixture.tables) };
});
const { auth } = await import("./index");
const { onUserBanned } = await import("./ban");
const { openLiveStream } = await vi.importActual<{
  openLiveStream: (
    userId: string,
    sessionId: string,
  ) => Promise<{
    signal: AbortSignal;
    assertOpen: () => void;
    untilBanned: <T>(work: Promise<T>) => Promise<T>;
    release: () => void;
  }>;
}>("../../api/src/lib/live-streams");
const { handlePasswordAuthRequest } = await import("./password-auth-handler");
const { withPasswordWriteLock } = await import("./password-write-lock");
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const { withPasswordSignInFence } = await import("./password-sign-in-fence");
const { recordResetLinkMailed } = await import("./password-reset-links");
const { createEmailVerificationToken, createAuthEndpoint } = await import("better-auth/api");
const { betterAuth } = await import("better-auth");
const { handleOAuthUserInfo } = await import("better-auth/oauth2");
const context = await auth.$context;
const hash = vi
  .spyOn(context.password, "hash")
  .mockImplementation(async (password) => `hash:${password}`);
vi.spyOn(context.password, "verify").mockImplementation(
  async ({ hash, password }) => hash === `hash:${password}`,
);
const userId = "invitee";
const email = "invitee@example.test";
const user = () => fixture.tables.user![0]!;
const credential = () => fixture.tables.account!.find((row) => row.providerId === "credential")!;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const reset = (token: string) =>
  handlePasswordAuthRequest(
    auth,
    new Request("https://app.example.test/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: JSON.stringify({ token, newPassword: `${token}-password-12345` }),
    }),
  );
async function link(token: string, mailed = false) {
  await fixture.client.verification.create({
    data: {
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  if (mailed) await recordResetLinkMailed({ token, userId, email });
}
async function verifyEmail() {
  const token = await createEmailVerificationToken(context.secret, email);
  return auth.handler(new Request(`https://app.example.test/api/auth/verify-email?token=${token}`));
}
const idpLink = () =>
  context.internalAdapter.createAccount({ providerId: "sso", accountId: "idp-user", userId });
beforeEach(() => {
  fixture.setSessionSweepBarrier();
  fixture.setLockBarrier();
  fixture.setReadBarrier();
  fixture.events.length = 0;
  fixture.controls.injectLateRows = false;
  fixture.controls.failAfterCallback = false;
  for (const key of Object.keys(fixture.tables)) delete fixture.tables[key];
  const now = new Date();
  fixture.tables.user = [
    { id: userId, name: "Invitee", email, emailVerified: false, createdAt: now, updatedAt: now },
  ];
  fixture.tables.account = [
    {
      id: "credential",
      accountId: userId,
      userId,
      providerId: "credential",
      password: "hash:prior-password",
      createdAt: now,
      updatedAt: now,
    },
  ];
  fixture.tables.session = [];
  fixture.tables.verification = [];
  hash.mockImplementation(async (password) => `hash:${password}`);
});

describe("selective reset spend and activation through production hooks", () => {
  it.each(["shown", "mailed"])(
    "serializes %s first against the other reset, with mailbox proof atomic",
    async (first) => {
      await link("shown");
      await link("mailed", true);
      const hashing = deferred();
      const release = deferred();
      const queued = deferred();
      hash.mockImplementationOnce(async (password) => {
        hashing.resolve();
        await release.promise;
        return `hash:${password}`;
      });
      const winning = reset(first);
      await hashing.promise;
      const other = first === "shown" ? "mailed" : "shown";
      fixture.setReadBarrier((where) => {
        if (where.identifier === `reset-password:${other}`) queued.resolve();
      });
      const losing = reset(other);
      await queued.promise;
      release.resolve();
      expect((await winning).status).toBe(200);
      expect((await losing).status).toBe(400);
      expect(user().emailVerified).toBe(first === "mailed");
      expect(credential().password).toBe(`hash:${first}-password-12345`);
      expect(fixture.peak()).toBeLessThanOrEqual(2); // pool 3, one ordinary connection remains
    },
  );
  it.each(["shown", "verify"])(
    "serializes %s first against verify-email at the actual write",
    async (first) => {
      await link("shown");
      const entered = deferred();
      const release = deferred();
      const queued = deferred();
      if (first === "shown")
        hash.mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return `hash:${password}`;
        });
      else
        fixture.setLockBarrier(async () => {
          entered.resolve();
          await release.promise;
        });
      const winning = first === "shown" ? reset("shown") : verifyEmail();
      await entered.promise;
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:shown") queued.resolve();
      });
      const losing = first === "shown" ? verifyEmail() : reset("shown");
      if (first === "verify") await queued.promise;
      release.resolve();
      expect((await winning).status).toBe(200);
      expect((await losing).status).toBe(first === "shown" ? 200 : 400);
      expect(user().emailVerified).toBe(true);
      expect(credential().password).toBe(
        first === "shown" ? "hash:shown-password-12345" : "hash:prior-password",
      );
    },
  );
  it("preserves the pinned default denial of implicit linking to an unverified local account", async () => {
    // Drive the pinned default linking algorithm from an HTTP callback context;
    // no provider trust or accountLinking override is supplied.
    const callbackAuth = betterAuth({
      ...auth.options,
      plugins: [
        ...(auth.options.plugins ?? []),
        {
          id: "test-pending-idp-callback",
          endpoints: {
            deniedPendingIdp: createAuthEndpoint(
              "/callback/pending-test",
              { method: "GET" },
              async (ctx) => {
                const result = await handleOAuthUserInfo(ctx, {
                  userInfo: { id: "idp-user", email, name: "Invitee", emailVerified: true },
                  account: { providerId: "sso", accountId: "idp-user" },
                  callbackURL: "https://app.example.test/",
                });
                return ctx.json({ error: result.error });
              },
            ),
          },
        },
      ],
    });
    const response = await callbackAuth.handler(
      new Request("https://app.example.test/api/auth/callback/pending-test"),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("account not linked");
    expect(credential().password).toBe("hash:prior-password");
    expect(fixture.tables.account).toHaveLength(1);
    expect(user().emailVerified).toBe(false);
  });
  it("clears a pending invite's prior shown password before IdP activation, preserving the IdP session", async () => {
    await link("shown");
    expect((await reset("shown")).status).toBe(200);
    fixture.tables.mcpAgentToken = [{ id: "key", userId, revokedAt: null }];
    await idpLink();
    expect(credential().password).toBeNull();
    expect(fixture.tables.mcpAgentToken?.[0]?.revokedAt).toBeInstanceOf(Date);
    await context.internalAdapter.updateUser(userId, { emailVerified: true });
    expect(user().emailVerified).toBe(true);
    expect(fixture.tables.verification).toEqual([]);
    // Actual session hooks allow only the established IdP callback proof.
    const sessionHooks = context.options.databaseHooks!.session!.create!;
    await sessionHooks.before!(
      { userId } as Parameters<NonNullable<typeof sessionHooks.before>>[0],
      { path: "/callback/sso" } as never,
    );
  });
  it("keeps a zero-account invite pending before authorized IdP insertion and revokes its standing credentials", async () => {
    fixture.tables.account = [];
    fixture.tables.mcpAgentToken = [{ id: "key", userId, revokedAt: null }];
    fixture.tables.mcpGrant = [{ id: "grant", userId, revokedAt: null }];
    fixture.controls.injectLateRows = true;
    await idpLink();
    expect(fixture.tables.account).toHaveLength(1);
    expect(fixture.tables.account?.[0]?.providerId).toBe("sso");
    expect(fixture.tables.mcpAgentToken?.[0]?.revokedAt).toBeInstanceOf(Date);
    expect(fixture.tables.mcpGrant?.[0]?.revokedAt).toBeInstanceOf(Date);
    expect(fixture.tables.session).toEqual([]);
    expect(fixture.tables.verification).toEqual([]);
    expect(user().emailVerified).toBe(false);
  });
  it("finds a disqualifying IdP account beyond the first two credential rows", async () => {
    const original = { ...credential() };
    fixture.tables.account = [
      original,
      { ...original, id: "credential2" },
      { id: "linked", userId, providerId: "other-idp", accountId: "linked" },
    ];
    fixture.tables.mcpAgentToken = [{ id: "key", userId, revokedAt: null }];
    await idpLink();
    expect(credential().password).toBe("hash:prior-password");
    expect(fixture.tables.mcpAgentToken?.[0]?.revokedAt).toBeNull();
  });
  it.each(["session", "challenge"])(
    "an old-password %s delayed across SSO cleanup cannot survive",
    async (kind) => {
      const entered = deferred();
      const release = deferred();
      const request = new Request("https://app.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "prior-password" }),
      });
      const pending = withPasswordSignInFence(request, async () => {
        const hooks = context.options.databaseHooks!;
        await hooks.session!.create!.before!(
          { userId } as never,
          { path: "/sign-in/email" } as never,
        );
        entered.resolve();
        await release.promise;
        if (kind === "session") {
          fixture.tables.session!.push({ id: "late-session", userId });
          await hooks.session!.create!.after!(
            { id: "late-session", userId } as never,
            { path: "/sign-in/email" } as never,
          );
        } else {
          const row = {
            identifier: "2fa-late",
            value: userId,
            expiresAt: new Date(Date.now() + 60_000),
          };
          await fixture.client.verification.create({ data: row });
          await hooks.verification!.create!.after!(row as never);
        }
        return new Response("ok");
      });
      await entered.promise;
      await idpLink();
      release.resolve();
      expect((await pending).status).toBe(401);
      expect(fixture.tables.session).toEqual([]);
      expect(fixture.tables.verification).toEqual([]);
    },
  );
  it.each(["shown", "sso"])(
    "serializes %s first against an IdP link before verification",
    async (first) => {
      await link("shown");
      const entered = deferred();
      const release = deferred();
      const queued = deferred();
      if (first === "shown")
        hash.mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return `hash:${password}`;
        });
      else
        fixture.setLockBarrier(async () => {
          entered.resolve();
          await release.promise;
        });
      const winning = first === "shown" ? reset("shown") : idpLink();
      await entered.promise;
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:shown") queued.resolve();
      });
      const losing = first === "shown" ? idpLink() : reset("shown");
      if (first === "sso") await queued.promise;
      release.resolve();
      await winning;
      await losing;
      expect(credential().password).toBeNull();
      expect(fixture.tables.account?.some((row) => row.providerId === "sso")).toBe(true);
    },
  );
  it("sweeps old-proof sessions/challenges inserted while the SSO clear was uncommitted", async () => {
    fixture.controls.injectLateRows = true;
    await idpLink();
    expect(fixture.tables.session).toEqual([]);
    expect(fixture.tables.verification).toEqual([]);
  });
  it("keeps standalone signup and its locale/SMTP callbacks outside transactions", async () => {
    const result = await auth.handler(
      new Request("https://app.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({
          name: "New",
          email: "new@example.test",
          password: "new-password-123456",
        }),
      }),
    );
    expect(result.status).toBe(200);
    expect(fixture.tables.user?.some((row) => row.email === "new@example.test")).toBe(true);
  });
  it.each([true, false])(
    "preserves active verified passwords / fresh OAuth signup (%s)",
    async (existingCredential) => {
      user().emailVerified = true;
      if (!existingCredential) fixture.tables.account = [];
      await idpLink();
      expect(
        fixture.tables.account
          ?.filter((row) => row.providerId === "credential")
          .map((row) => row.password),
      ).toEqual(existingCredential ? ["hash:prior-password"] : []);
    },
  );
  it("routes verifying updateMany through the same activation transaction and setup decision", async () => {
    await link("shown");
    fixture.events.length = 0;
    await context.adapter.updateMany({
      model: "user",
      where: [{ field: "email", value: email }],
      update: { emailVerified: true },
    });
    expect(fixture.events[0]).toBe(`password-write:${userId}`);
    expect(fixture.events.indexOf(`set-password-link:${userId}`)).toBeGreaterThan(0);
    expect(user().emailVerified).toBe(true);
    expect(fixture.tables.verification).toEqual([]);
  });
  it("activation competitors progress locally before the real reset consumes its reserved slot", async () => {
    await link("mailed", true);
    await link("competing");
    fixture.tables.user!.push({ id: "other", email: "other@example.test", emailVerified: false });
    const entered = deferred();
    const release = deferred();
    const resetQueued = deferred();
    const order: string[] = [];
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    const activate = () =>
      context.adapter.update({
        model: "user",
        where: [{ field: "id", value: "other" }],
        update: { emailVerified: true },
      });
    let paused = false;
    fixture.setLockBarrier(async (key) => {
      if (key !== "password-write:other" || paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    });
    hash.mockImplementationOnce(async (password) => {
      // Both calls inherit the actual password holder's ALS reservation.
      first = activate().then(() => {
        order.push("first");
      });
      await entered.promise;
      second = activate().then(() => {
        order.push("second");
      });
      return `hash:${password}`;
    });
    const transaction = context.adapter.transaction.bind(context.adapter);
    const spy = vi.spyOn(context.adapter, "transaction").mockImplementation((callback) => {
      const result = transaction(callback);
      resetQueued.resolve();
      return result;
    });
    const spending = reset("mailed");
    try {
      await resetQueued.promise;
      expect(fixture.connections()).toBe(2);
      expect(fixture.events.filter((key) => key === "password-write:other")).toHaveLength(1);
      release.resolve();
      // This bound detects the local/global self-deadlock, not race ordering.
      await expect(
        Promise.race([
          spending.then((response) => response.status),
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("reset stalled"), 1_000);
            timer.unref();
          }),
        ]),
      ).resolves.toBe(200);
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
      expect(user().emailVerified).toBe(true);
      expect(credential().password).toBe("hash:mailed-password-12345");
      expect(fixture.tables.verification).toEqual([]);
      expect(fixture.peak()).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });

  it("an activation borrower stays charged after its password holder exits and a queued reset progresses", async () => {
    await link("mailed", true);
    fixture.tables.user!.push({ id: "other", email: "other@example.test", emailVerified: false });
    const entered = deferred();
    const release = deferred();
    let activation!: Promise<unknown>;
    fixture.setLockBarrier(async (key) => {
      if (key !== "password-write:other") return;
      entered.resolve();
      await release.promise;
    });
    await withPasswordWriteLock(
      "/admin/set-user-password",
      new Request("https://app.example.test/api/auth/admin/set-user-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
      async () => {
        activation = context.adapter.update({
          model: "user",
          where: [{ field: "id", value: "other" }],
          update: { emailVerified: true },
        });
        await entered.promise;
        return new Response("holder finished");
      },
      { getSession: async () => null },
    );
    try {
      expect(fixture.connections()).toBe(1);
      const pairAvailable = tryAcquireSlots(2);
      if (pairAvailable) releaseSlots(2);
      expect(pairAvailable).toBe(false);
      expect(tryAcquireSlots()).toBe(true);
      releaseSlots();
      const queued = deferred();
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:mailed") queued.resolve();
      });
      const spending = reset("mailed");
      await queued.promise;
      expect(credential().password).toBe("hash:prior-password");
      release.resolve();
      await activation;
      expect((await spending).status).toBe(200);
      expect(credential().password).toBe("hash:mailed-password-12345");
      expect(fixture.peak()).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      await activation;
    }
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("does not run queued account after-hooks for a reset transaction that rolled back", async () => {
    await link("mailed", true);
    const hooks = context.options.databaseHooks!.account!.update!;
    const after = vi.spyOn(hooks, "after");
    fixture.controls.failAfterCallback = true;
    try {
      expect((await reset("mailed")).status).toBe(500);
      expect(after).not.toHaveBeenCalled();
      expect(user().emailVerified).toBe(false);
      expect(credential().password).toBe("hash:prior-password");
      expect((await reset("mailed")).status).toBe(200);
      expect(after).toHaveBeenCalledOnce();
    } finally {
      after.mockRestore();
    }
  });
  it("rolls back token, proof and verification when the password commit fails", async () => {
    await link("mailed", true);
    const update = vi
      .spyOn(context.internalAdapter, "updatePassword")
      .mockRejectedValueOnce(new Error("write unavailable"));
    expect((await reset("mailed")).status).toBe(500);
    expect(user().emailVerified).toBe(false);
    expect(credential().password).toBe("hash:prior-password");
    expect(
      fixture.tables.verification?.some((row) => row.identifier === "reset-password:mailed"),
    ).toBe(true);
    update.mockRestore();
    expect((await reset("mailed")).status).toBe(200);
    expect(user().emailVerified).toBe(true);
  });
});

it.each([false, true])(
  "pending IdP activation closes streams/MCP admitted during final sweep, including failure (%s)",
  async (fail) => {
    const entered = deferred();
    const release = deferred();
    let inserted = false;
    fixture.controls.injectLateRows = true;
    fixture.setSessionSweepBarrier(async () => {
      entered.resolve();
      await release.promise;
      if (fail) throw new Error("sweep unavailable");
    });
    const announcements: string[] = [];
    const mcpExchange = new AbortController();
    const stop = onUserBanned((id, origin) => {
      if (id === userId) {
        announcements.push(origin);
        expect(inserted).toBe(false);
        mcpExchange.abort();
      }
    });
    const linking = idpLink().then((result) => {
      inserted = true;
      return result;
    });
    const outcome = linking.then(
      () => "ok",
      () => "failed",
    );
    await entered.promise;
    const old = fixture.tables.session!.find((row) => row.id === "before-commit")!;
    old.expiresAt = new Date(Date.now() + 60_000);
    const stream = await openLiveStream(userId, "before-commit");
    try {
      expect(stream.signal.aborted).toBe(false);
      expect(mcpExchange.signal.aborted).toBe(false);
      release.resolve();
      expect(await outcome).toBe(fail ? "failed" : "ok");
      expect(stream.signal.aborted).toBe(true);
      expect(mcpExchange.signal.aborted).toBe(true);
      expect(() => stream.assertOpen()).toThrow();
      await expect(stream.untilBanned(new Promise(() => {}))).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(announcements).toEqual(["session-revocation"]);
      expect(credential().password).toBeNull();
      if (!fail) {
        await expect(openLiveStream(userId, "before-commit")).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
        // Test-only callback invokes the pinned IdP algorithm with the existing
        // production options and linking defaults, after the authorized link seam.
        const callbackAuth = betterAuth({
          ...auth.options,
          plugins: [
            ...(auth.options.plugins ?? []),
            {
              id: "test-idp-callback",
              endpoints: {
                finishIdp: createAuthEndpoint(
                  "/callback/activation-test",
                  { method: "GET" },
                  async (ctx) => {
                    const result = await handleOAuthUserInfo(ctx, {
                      userInfo: { id: "idp-user", email, name: "Invitee", emailVerified: true },
                      account: { providerId: "sso", accountId: "idp-user" },
                      callbackURL: "https://app.example.test/",
                    });
                    return ctx.json({ session: result.data?.session, error: result.error });
                  },
                ),
              },
            },
          ],
        });
        const response = await callbackAuth.handler(
          new Request("https://app.example.test/api/auth/callback/activation-test"),
        );
        expect(response.status).toBe(200);
        const result = (await response.json()) as { session: { id: string } };
        expect(result.session?.id).toBeTypeOf("string");
        expect(fixture.tables.session?.some((row) => row.id === result.session.id)).toBe(true);
      }
    } finally {
      release.resolve();
      stream.release();
      stop();
      fixture.setSessionSweepBarrier();
    }
  },
);
