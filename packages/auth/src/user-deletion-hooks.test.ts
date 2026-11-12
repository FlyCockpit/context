import { expect, it, vi } from "vitest";

it("fails closed when cleanup is absent and awaits registered cleanup before deletion", async () => {
  vi.resetModules();
  const { cleanupBeforeUserDeletion, registerUserDeletionCleanup } = await import(
    "./user-deletion-hooks"
  );
  await expect(cleanupBeforeUserDeletion("u")).rejects.toThrow("not configured");
  const cleanup = vi.fn(async () => {});
  registerUserDeletionCleanup(cleanup);
  await cleanupBeforeUserDeletion("u");
  expect(cleanup).toHaveBeenCalledWith("u");
  cleanup.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(cleanupBeforeUserDeletion("u")).rejects.toThrow("cleanup failed");
});
