import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/db", async () => {
  const { createMockContext } = await vi.importActual<{
    createMockContext: () => { db: typeof prisma };
  }>("../../test-utils/src/index");
  return { default: createMockContext().db };
});
const { default: prisma } = await import("@cockpit-context/db");
const db = vi.mocked(prisma, { deep: true });
const {
  quarantineUntrustedPasswordWrite,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
  passwordChangeRevocationTarget,
} = await import("./credential-revocation");
const { withCredentialSetupLock } = await import("./password-reset-links");
const { withUserCredentialTransaction } = await import("./oauth-revocation");
const { withPasswordWriteLock } = await import("./password-write-lock");
const { tryAcquireSlots, releaseSlots } = await import("./lock-slots");
let events: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  db.$executeRaw.mockResolvedValue(1);
  db.$queryRaw.mockResolvedValue([{ locked: true }]);
  db.$transaction.mockImplementation(async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[]),
  );
  (db.account.updateMany as MockInstance).mockImplementation(async () => {
    events.push("scramble");
    return { count: 1 };
  });
  (db.session.deleteMany as MockInstance).mockImplementation(async () => {
    events.push("sessions");
    return { count: 1 };
  });
  for (const write of [
    db.mcpAgentToken.updateMany,
    db.mcpGrant.updateMany,
    db.oauthAccessToken.deleteMany,
    db.oauthRefreshToken.deleteMany,
    db.oauthConsent.deleteMany,
  ])
    write.mockResolvedValue({ count: 1 });
});

describe("credential revocation writes", () => {
  it("deletes every session in both reset sweeps, keeping only the issued token on change", async () => {
    await revokeCredentialsAfterPasswordReset("u");
    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: "u" } });
    db.session.deleteMany.mockClear();
    await revokeCredentialsAfterPasswordChange({ userId: "u", keepSessionToken: "new-token" });
    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "u", token: { not: "new-token" } },
    });
  });
  it("scrambles an untrusted write before deleting sessions and standing MCP credentials, retrying a failed scramble", async () => {
    db.account.updateMany.mockRejectedValueOnce(new Error("retry scramble"));
    const hash = vi.fn(async () => "peppered-unusable-hash");
    await quarantineUntrustedPasswordWrite("u", { hash });
    expect(hash).toHaveBeenCalledOnce();
    expect(db.account.updateMany).toHaveBeenCalledTimes(2);
    expect(db.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "u", providerId: "credential" },
      data: { password: "peppered-unusable-hash" },
    });
    expect(events).toEqual(["scramble", "sessions"]);
    expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u", revokedAt: null } }),
    );
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u", revokedAt: null } }),
    );
    for (const write of [
      db.oauthAccessToken.deleteMany,
      db.oauthRefreshToken.deleteMany,
      db.oauthConsent.deleteMany,
    ])
      expect(write).toHaveBeenCalledWith({ where: { userId: "u" } });
  });
  it("requires a successful change with an issued keep token before revocation", () => {
    const valid = {
      path: "/change-password",
      body: { revokeOtherSessions: true },
      returned: { user: { id: "u" }, token: "new-token" },
    };
    expect(passwordChangeRevocationTarget(valid)).toEqual({
      userId: "u",
      keepSessionToken: "new-token",
    });
    for (const returned of [null, {}, { user: { id: "u" } }, { user: { id: "u" }, token: "" }])
      expect(passwordChangeRevocationTarget({ ...valid, returned })).toBeNull();
    expect(
      passwordChangeRevocationTarget({ ...valid, body: { revokeOtherSessions: false } }),
    ).toBeNull();
  });
  it.each(["credential", "setup"])("the %s lock uses the ONE slot accounting", async (kind) => {
    const run = async () => {
      // One of two slots is held; a new two-slot password writer must wait.
      const acquired = tryAcquireSlots(2);
      if (acquired) releaseSlots(2);
      expect(acquired).toBe(false);
    };
    if (kind === "credential") await withUserCredentialTransaction("u", run);
    else await withCredentialSetupLock("u", run);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });
  it("password-write -> credential -> setup reuses its reserved slot with a pool of three", async () => {
    db.verification.findFirst.mockResolvedValue({
      id: "v",
      identifier: "reset-password:t",
      value: "u",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const request = new Request("https://app.example.test/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    const response = await withPasswordWriteLock(
      "/reset-password",
      request,
      async () => {
        await revokeCredentialsAfterPasswordReset("u");
        await withCredentialSetupLock("u", async () => {
          events.push("setup");
        });
        return new Response("ok");
      },
      { getSession: async () => null },
    );
    expect(response.status).toBe(200);
    expect(events).toEqual(["sessions", "setup"]);
    expect(db.$executeRaw.mock.calls.map(([sql]) => String(sql))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1936028274"),
        expect.stringContaining("WITH challenges"),
        expect.stringContaining("pg_advisory_xact_lock(hashtext("),
      ]),
    );
  });
});
