import { beforeEach, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof import("@cockpit-context/db").default>() };
});
const { default: prisma } = await import("@cockpit-context/db");
const db = prisma as unknown as { appSetting: { findMany: MockInstance } };
const { invalidateForceTwoFactorSettingsCache, isForcedTwoFactorEnabledForRole } = await import(
  "./two-factor-policy"
);
beforeEach(() => {
  vi.clearAllMocks();
  invalidateForceTwoFactorSettingsCache();
});
it("retries a stale read after invalidation without reinstalling an old 2FA policy", async () => {
  let finish: (rows: { key: string; value: string }[]) => void = () => {};
  db.appSetting.findMany.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = isForcedTwoFactorEnabledForRole("admin");
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
  await expect(isForcedTwoFactorEnabledForRole("admin")).resolves.toBe(true);
  finish([{ key: "force2faInternalUsers", value: "false" }]);
  await expect(old).resolves.toBe(true);
  await expect(isForcedTwoFactorEnabledForRole("admin")).resolves.toBe(true);
});
