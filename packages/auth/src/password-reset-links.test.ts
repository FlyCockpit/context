import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB: an in-memory verification table and user table, enough to
// see which rows a reset reads, writes and consumes.
type Row = { identifier: string; value: string; expiresAt: Date };
const state = vi.hoisted(() => ({
  verifications: [] as Row[],
  users: [] as {
    id: string;
    email: string;
    emailVerified: boolean;
    accounts?: { providerId: string }[];
    sessions?: { id: string }[];
  }[],
  locks: [] as string[],
  /** Every statement in order, to see what ran under the lock. */
  calls: [] as string[],
}));
const db = vi.hoisted(() => {
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (typeof where.identifier === "string" && row.identifier !== where.identifier) return false;
    if (
      typeof where.identifier === "object" &&
      where.identifier !== null &&
      (!row.identifier.startsWith((where.identifier as { startsWith: string }).startsWith) ||
        row.identifier === (where.identifier as { not?: string }).not)
    )
      return false;
    if (where.value !== undefined && row.value !== where.value) return false;
    const expiry = where.expiresAt as { gt: Date } | undefined;
    if (expiry && !(row.expiresAt > expiry.gt)) return false;
    return true;
  };
  const client = {
    verification: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.push("verification.findFirst");
        return state.verifications.find((row) => matches(row, where)) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.calls.push("verification.create");
        state.verifications.push(data);
        return { id: "v" };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = state.verifications.length;
        state.verifications = state.verifications.filter((row) => !matches(row, where));
        return { count: before - state.verifications.length };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.calls.push("user.findUnique");
        const user = state.users.find((u) => u.id === where.id);
        if (!user) return null;
        return {
          email: user.email,
          emailVerified: user.emailVerified,
          accounts: user.accounts ?? [{ providerId: "credential" }],
          sessions: user.sessions ?? [],
        };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; email: string };
          data: { emailVerified: boolean };
        }) => {
          const hit = state.users.filter((u) => u.id === where.id && u.email === where.email);
          for (const user of hit) user.emailVerified = data.emailVerified;
          return { count: hit.length };
        },
      ),
    },
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      state.locks.push(key);
      state.calls.push("lock");
      return 1;
    }),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) =>
    operation(client),
  );
  return client;
});
vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/db", () => ({ default: db }));

const {
  isResetLinkRedeemable,
  lockCredentialSetup,
  recordResetLinkMailed,
  resetTokenOf,
  admitResetSpend,
  inviteStateSelect,
  isInvitePending,
} = await import("./password-reset-links");

const now = new Date("2026-11-26T00:00:00Z");
const expiresAt = new Date("2026-12-01T00:00:00Z");
/** A reset link as Better-Auth (or an invite) writes it. */
function link(token: string, userId = "u1") {
  state.verifications.push({ identifier: `reset-password:${token}`, value: userId, expiresAt });
}

beforeEach(() => {
  // Calls that take the default clock see the same day as `now`, so the
  // fixtures (expiring 2026-12-01) stay valid whenever the suite runs.
  vi.useFakeTimers({ now, toFake: ["Date"] });
  vi.clearAllMocks();
  state.verifications = [];
  state.users = [{ id: "u1", email: "ada@example.com", emailVerified: false }];
  state.locks = [];
  state.calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordResetLinkMailed", () => {
  it("records a mailed link beside it, keyed by the token's hash, expiring with it", async () => {
    link("tok-1");
    expect(
      await recordResetLinkMailed({ token: "tok-1", userId: "u1", email: "Ada@Example.com", now }),
    ).toBe(true);
    const mailed = state.verifications.find((row) =>
      row.identifier.startsWith("reset-password-mailed:"),
    );
    const hash = createHash("sha256").update("tok-1").digest("base64url");
    expect(mailed).toEqual({
      identifier: `reset-password-mailed:${hash}`,
      value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
      expiresAt,
    });
    // The token itself is stored once only: in Better-Auth's own row.
    expect(state.verifications.filter((row) => row.identifier.includes("tok-1"))).toHaveLength(1);
  });

  it("records nothing for a link that is already gone", async () => {
    expect(
      await recordResetLinkMailed({ token: "gone", userId: "u1", email: "ada@example.com" }),
    ).toBe(false);
    link("someone-else", "u2");
    expect(
      await recordResetLinkMailed({
        token: "someone-else",
        userId: "u1",
        email: "ada@example.com",
      }),
    ).toBe(false);
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("checks the link and writes the record in one transaction, under the setup lock", async () => {
    link("tok-1");
    await recordResetLinkMailed({ token: "tok-1", userId: "u1", email: "ada@example.com", now });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The lock comes first, so a resend, reset or activation (which delete
    // links under it) cannot delete the link between the check and the insert.
    expect(state.calls).toEqual(["lock", "verification.findFirst", "verification.create"]);
    expect(state.locks).toEqual(["set-password-link:u1"]);
  });

  it("records nothing for an expired link", async () => {
    state.verifications.push({
      identifier: "reset-password:old",
      value: "u1",
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(
      await recordResetLinkMailed({ token: "old", userId: "u1", email: "ada@example.com", now }),
    ).toBe(false);
    expect(db.verification.create).not.toHaveBeenCalled();
  });
});

describe("isResetLinkRedeemable", () => {
  const verified = () => {
    const user = state.users[0];
    if (user) user.emailVerified = true;
  };
  const mailedLink = async (token: string) => {
    link(token);
    await recordResetLinkMailed({ token, userId: "u1", email: "ada@example.com", now });
  };

  it("lets a mailed link work for an active account (forgot-password)", async () => {
    await mailedLink("forgot");
    verified();
    state.locks = [];
    expect(await isResetLinkRedeemable("forgot", { emailConfigured: true, now })).toBe(true);
    expect(state.locks).toEqual([]);
    expect(state.verifications.some((row) => row.identifier === "reset-password:forgot")).toBe(
      true,
    );
  });

  it("lets a shown link work while the invite is pending", async () => {
    link("shown");
    expect(await isResetLinkRedeemable("shown", { emailConfigured: true, now })).toBe(true);
  });

  it("refuses and deletes a shown link once the account is active, under the setup lock", async () => {
    link("shown");
    verified();
    expect(await isResetLinkRedeemable("shown", { emailConfigured: true, now })).toBe(false);
    expect(state.verifications).toEqual([]);
    expect(state.locks).toEqual(["set-password-link:u1"]);
    // Link, mailed record, the lock, the mailed record again, then the invite state.
    expect(state.calls.slice(0, 5)).toEqual([
      "verification.findFirst",
      "verification.findFirst",
      "lock",
      "verification.findFirst",
      "user.findUnique",
    ]);
  });

  it("refuses a shown link once an IdP identity is linked or the user signed in", async () => {
    link("shown");
    const user = state.users[0];
    if (!user) throw new Error("seed");
    user.accounts = [{ providerId: "credential" }, { providerId: "sso" }];
    expect(await isResetLinkRedeemable("shown", { emailConfigured: true, now })).toBe(false);
    link("shown-2");
    user.accounts = undefined;
    user.sessions = [{ id: "s1" }];
    expect(await isResetLinkRedeemable("shown-2", { emailConfigured: true, now })).toBe(false);
  });

  it("does not take another user's mailed record, or an expired one, as this link's", async () => {
    link("shown");
    verified();
    const hash = createHash("sha256").update("shown").digest("base64url");
    state.verifications.push({
      identifier: `reset-password-mailed:${hash}`,
      value: JSON.stringify({ userId: "u2", email: "x@example.com" }),
      expiresAt,
    });
    expect(await isResetLinkRedeemable("shown", { emailConfigured: true, now })).toBe(false);
    link("late");
    const lateHash = createHash("sha256").update("late").digest("base64url");
    state.verifications.push({
      identifier: `reset-password-mailed:${lateHash}`,
      value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(await isResetLinkRedeemable("late", { emailConfigured: true, now })).toBe(false);
  });

  it("admits a link whose mailed record committed while the check waited for the lock", async () => {
    link("racing");
    verified();
    const hash = createHash("sha256").update("racing").digest("base64url");
    // The record's writer held the setup lock; it commits as the lock is granted.
    db.$executeRaw.mockImplementationOnce(async (_strings: TemplateStringsArray, key: string) => {
      state.locks.push(key);
      state.calls.push("lock");
      state.verifications.push({
        identifier: `reset-password-mailed:${hash}`,
        value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
        expiresAt,
      });
      return 1;
    });
    expect(await isResetLinkRedeemable("racing", { emailConfigured: true, now })).toBe(true);
    expect(state.verifications.some((row) => row.identifier === "reset-password:racing")).toBe(
      true,
    );
  });

  it("leaves an unknown or expired token to Better-Auth, which refuses it itself", async () => {
    expect(await isResetLinkRedeemable("nope", { emailConfigured: true, now })).toBe(true);
    state.verifications.push({
      identifier: "reset-password:expired",
      value: "u1",
      expiresAt: new Date(now.getTime() - 1),
    });
    verified();
    expect(await isResetLinkRedeemable("expired", { emailConfigured: true, now })).toBe(true);
    expect(state.locks).toEqual([]);
  });
});

describe("admitResetSpend", () => {
  const admit = (token: string) =>
    admitResetSpend(db as unknown as Parameters<typeof admitResetSpend>[0], token, {
      emailConfigured: true,
      now,
    });
  it("commits mailed proof and other-link deletion on the supplied transaction", async () => {
    state.users = [{ id: "u1", email: "u@example.test", emailVerified: false }];
    link("mailed");
    link("other");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "u@example.test" });
    db.$transaction.mockClear();
    expect(await admit("mailed")).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(true);
    expect(state.verifications.map((v) => v.identifier)).toEqual(["reset-password:mailed"]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("shown links never verify and are rejected after verification or IdP linking", async () => {
    state.users = [{ id: "u1", email: "u@example.test", emailVerified: false }];
    link("shown");
    expect(await admit("shown")).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(false);
    state.users[0]!.emailVerified = true;
    expect(await admit("shown")).toBe(false);
    state.users[0]!.emailVerified = false;
    state.users[0]!.accounts = [{ providerId: "credential" }, { providerId: "sso" }];
    expect(await admit("shown")).toBe(false);
  });
  it("does not trust a mailed record for a different mailbox", async () => {
    state.users = [{ id: "u1", email: "new@example.test", emailVerified: true }];
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "old@example.test" });
    expect(await admit("mailed")).toBe(false);
  });
});

it("no-SMTP active shown links are admitted atomically without verifying an unproved address", async () => {
  state.users = [
    {
      id: "u1",
      email: "u@example.test",
      emailVerified: false,
      accounts: [{ providerId: "credential" }, { providerId: "sso" }],
      sessions: [{ id: "live" }],
    },
  ];
  link("shown");
  link("other");
  expect(await isResetLinkRedeemable("shown", { emailConfigured: false, now })).toBe(true);
  expect(
    await admitResetSpend(db as unknown as Parameters<typeof admitResetSpend>[0], "shown", {
      emailConfigured: false,
      now,
    }),
  ).toBe(true);
  expect(state.users[0]?.emailVerified).toBe(false);
  expect(db.user.updateMany).not.toHaveBeenCalled();
  expect(state.verifications.map((row) => row.identifier)).toEqual(["reset-password:shown"]);
});

describe("lockCredentialSetup", () => {
  it("is a transaction-scoped advisory lock keyed by the user", async () => {
    await lockCredentialSetup(db as never, "u9");
    const [strings, key] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("set-password-link:u9");
  });
});

describe("resetTokenOf", () => {
  it("is the token a /reset-password request carries, before it ran", () => {
    expect(resetTokenOf({ path: "/reset-password", body: { token: "t" } })).toBe("t");
    expect(resetTokenOf({ path: "/reset-password", query: { token: "q" } })).toBe("q");
    expect(resetTokenOf({ path: "/reset-password", body: { token: 1 } })).toBe(null);
    expect(resetTokenOf({ path: "/request-password-reset", body: { token: "t" } })).toBe(null);
  });
});

it("preserves Context's empty-account pending policy with a bounded noncredential projection", () => {
  expect(isInvitePending({ emailVerified: false, accounts: [], sessions: [] })).toBe(true);
  expect(
    isInvitePending({
      emailVerified: false,
      accounts: [{ providerId: "credential" }, { providerId: "credential" }],
      sessions: [],
    }),
  ).toBe(true);
  expect(
    isInvitePending({ emailVerified: false, accounts: [{ providerId: "sso" }], sessions: [] }),
  ).toBe(false);
  expect(inviteStateSelect(now).accounts).toEqual({
    where: { providerId: { not: "credential" } },
    select: { providerId: true },
    take: 1,
  });
});
