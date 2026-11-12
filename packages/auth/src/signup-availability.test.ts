import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { SIGNUP_ENABLED: true, ADMIN_EMAILS: new Set<string>() };
vi.mock("@cockpit-context/env/server", () => ({
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
  get ADMIN_EMAILS() {
    return envMock.ADMIN_EMAILS;
  },
}));

// Hand-rolled: only the two reads this module makes (vitest-mock-extended is
// not a dependency of this package).
const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@cockpit-context/db", () => ({ default: db }));

const {
  getSignupAvailability,
  hasAnyAdmin,
  hasAnyUser,
  invalidateSignupAvailabilityCache,
  isSignupOpen,
} = await import("./signup-availability");
const { issueBootstrapToken, revokeBootstrapToken } = await import("./bootstrap-token");

describe("signup availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSignupAvailabilityCache();
    envMock.SIGNUP_ENABLED = true;
    envMock.ADMIN_EMAILS = new Set();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([]);
    db.user.findFirst.mockResolvedValue(null);
    revokeBootstrapToken();
  });

  it("does not reinstall a signup read started before invalidation", async () => {
    let finish: (row: { value: string }) => void = () => {};
    db.appSetting.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = isSignupOpen();
    invalidateSignupAvailabilityCache();
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });
    await expect(isSignupOpen()).resolves.toBe(false);
    finish({ value: "true" });
    await expect(old).resolves.toBe(false);
    await expect(isSignupOpen()).resolves.toBe(false);
  });

  it("does not reinstall an admin-existence read started before invalidation", async () => {
    let finish: (rows: { role: string }[]) => void = () => {};
    db.user.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = hasAnyAdmin();
    invalidateSignupAvailabilityCache();
    db.user.findMany.mockResolvedValue([{ role: "admin" }]);
    await expect(hasAnyAdmin()).resolves.toBe(true);
    finish([]);
    await expect(old).resolves.toBe(true);
    await expect(hasAnyAdmin()).resolves.toBe(true);
  });

  it("does not touch the database when the env ceiling is off", async () => {
    envMock.SIGNUP_ENABLED = false;
    await expect(isSignupOpen()).resolves.toBe(false);
    expect(db.appSetting.findUnique).not.toHaveBeenCalled();
  });

  it("reads the signupOpen row and caches it until invalidated", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });
    await expect(isSignupOpen()).resolves.toBe(false);
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    await expect(isSignupOpen()).resolves.toBe(false);
    expect(db.appSetting.findUnique).toHaveBeenCalledOnce();
    expect(db.appSetting.findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { key: "signupOpen" },
    });

    invalidateSignupAvailabilityCache();
    await expect(isSignupOpen()).resolves.toBe(true);
  });

  it("detects admins by parsed role, not by substring", async () => {
    db.user.findMany.mockResolvedValue([{ role: "superadmin" }]);
    await expect(hasAnyAdmin({ fresh: true })).resolves.toBe(false);
    db.user.findMany.mockResolvedValue([{ role: "user, Admin" }]);
    await expect(hasAnyAdmin({ fresh: true })).resolves.toBe(true);
    // The candidate scan is bounded.
    expect(db.user.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 50 });
  });

  it("bypasses the cache for fresh reads (the user-create hook)", async () => {
    await expect(hasAnyAdmin()).resolves.toBe(false);
    db.user.findMany.mockResolvedValue([{ role: "admin" }]);
    await expect(hasAnyAdmin()).resolves.toBe(false);
    await expect(hasAnyAdmin({ fresh: true })).resolves.toBe(true);
  });

  it("reports the bootstrap only while no account exists and a token is active", async () => {
    envMock.SIGNUP_ENABLED = false;
    envMock.ADMIN_EMAILS = new Set(["owner@example.com"]);
    issueBootstrapToken();
    await expect(getSignupAvailability()).resolves.toEqual({
      signupOpen: false,
      adminBootstrapOpen: true,
      adminSetup: "bootstrap",
    });

    // One non-admin account closes it for good.
    invalidateSignupAvailabilityCache();
    db.user.findFirst.mockResolvedValue({ id: "u1" });
    await expect(getSignupAvailability()).resolves.toEqual({
      signupOpen: false,
      adminBootstrapOpen: false,
      adminSetup: "locked",
    });

    invalidateSignupAvailabilityCache();
    db.user.findMany.mockResolvedValue([{ role: "admin" }]);
    await expect(getSignupAvailability()).resolves.toEqual({
      signupOpen: false,
      adminBootstrapOpen: false,
      adminSetup: null,
    });
  });

  it("caches the account-existence read except for fresh reads", async () => {
    await expect(hasAnyUser()).resolves.toBe(false);
    db.user.findFirst.mockResolvedValue({ id: "u1" });
    await expect(hasAnyUser()).resolves.toBe(false);
    await expect(hasAnyUser({ fresh: true })).resolves.toBe(true);
  });

  it("skips the account read when an admin already exists", async () => {
    db.user.findMany.mockResolvedValue([{ role: "admin" }]);
    await getSignupAvailability();
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});
