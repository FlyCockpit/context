import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB. Each statement returns a tag so the batch is visible.
const db = vi.hoisted(() => ({
  verification: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-context/db", () => ({ default: db }));
vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const { afterAccountCreate, afterUserUpdate, deleteResetLinksOnActivation, noteVerificationWrite } =
  await import("./account-activation");

const CLEANUP = [
  "setupLock:set-password-link:u1",
  { where: { value: "u1", identifier: { startsWith: "reset-password:" } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRaw.mockImplementation(
    (_strings: TemplateStringsArray, key: string) => `setupLock:${key}`,
  );
  db.verification.deleteMany.mockImplementation((args: unknown) => args);
  db.$transaction.mockImplementation(async (run) => run(db));
});

describe("account activation kills leftover reset links", () => {
  it("runs the setup lock, then the reset-link delete, in one transaction after a verifying write", async () => {
    const context = { path: "/verify-email" };
    noteVerificationWrite({ emailVerified: true }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.verification.deleteMany).toHaveBeenCalledWith(CLEANUP[1]);
  });

  it("leaves other updates of a verified user alone", async () => {
    const context = { path: "/update-user" };
    noteVerificationWrite({ name: "Ada" }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    // An update that set emailVerified false, or an unverified row, either.
    const unverify = { path: "/admin/update-user" };
    noteVerificationWrite({ emailVerified: false }, unverify);
    await afterUserUpdate({ id: "u1", emailVerified: false }, unverify);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("cleans up a verified row written outside any endpoint context (fail safe)", async () => {
    await afterUserUpdate({ id: "u1", emailVerified: true }, null);
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.verification.deleteMany).toHaveBeenCalledWith(CLEANUP[1]);
  });

  it("cleans up when an IdP identity is linked, never for a credential account", async () => {
    await afterAccountCreate({ userId: "u1", providerId: "credential" });
    expect(db.$transaction).not.toHaveBeenCalled();
    await afterAccountCreate({ userId: "u1", providerId: "sso" });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.verification.deleteMany).toHaveBeenCalledWith(CLEANUP[1]);
  });

  it("retries, then logs the failure with the user id only and does not fail the activation", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValue(new Error("db down"));
    const sleep = vi.fn(async () => {});
    await expect(deleteResetLinksOnActivation("u1", { sleep })).resolves.toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("refused at redemption"), {
      userId: "u1",
      error: "Error: db down",
    });
    errorLog.mockRestore();
  });

  it("succeeds on a retry", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce([]);
    await expect(
      deleteResetLinksOnActivation("u1", { sleep: async () => {} }),
    ).resolves.toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});
