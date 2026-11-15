import { beforeEach, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof import("@cockpit-context/db").default>() };
});
const { stopAll, remove, forgetAnswers } = vi.hoisted(() => ({
  stopAll: vi.fn(),
  remove: vi.fn(),
  forgetAnswers: vi.fn(),
}));
vi.mock("@cockpit-context/repos", () => ({ deleteRepository: remove }));
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: () => ({ stopAllForOwner: stopAll }) }));
vi.mock("@cockpit-context/runs/answer-reuse", () => ({ invalidateAnswersForOwner: forgetAnswers }));
const { default: prisma } = await import("@cockpit-context/db");
const db = prisma as unknown as {
  repository: { findMany: MockInstance };
  user: { update: MockInstance; delete: MockInstance };
};
const { prepareUserDeletion, stopUserRuns } = await import("./user-deletion");
const { onUserBanned } = await import("@cockpit-context/auth/ban");
beforeEach(() => {
  vi.clearAllMocks();
  db.repository.findMany.mockResolvedValue([]);
});
it("stops all the user's runs before removing only their private repository files", async () => {
  db.repository.findMany.mockResolvedValue([{ id: "repo-1" }]);
  await prepareUserDeletion("u");
  // Main AND summary runs, queued or running: one owner-scoped engine call.
  expect(stopAll.mock.calls).toEqual([["u"]]);
  expect(prisma.repository.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { ownerId: "u", visibility: "PRIVATE" }, take: 100 }),
  );
  expect(remove).toHaveBeenCalledWith("repo-1", { force: true });
  // Blocked (banned) first, so the engine refuses any launch still in flight.
  expect(db.user.update.mock.invocationCallOrder[0]).toBeLessThan(
    stopAll.mock.invocationCallOrder[0]!,
  );
  expect(stopAll.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
  expect(prisma.user.delete).not.toHaveBeenCalled();
});
it("propagates cleanup failures so the caller cannot cascade away cleanup identity", async () => {
  db.repository.findMany.mockResolvedValue([{ id: "repo-1" }]);
  remove.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(prepareUserDeletion("u")).rejects.toThrow("disk unavailable");
  expect(prisma.user.delete).not.toHaveBeenCalled();
});
it("stops runs through the engine's owner-scoped stop-all and drops the owner's reusable answers", async () => {
  await stopUserRuns("u");
  expect(stopAll).toHaveBeenCalledExactlyOnceWith("u");
  expect(forgetAnswers).toHaveBeenCalledExactlyOnceWith("u");
});

it("bans, deletes sessions and announces the ban (closing live streams) before stopping runs", async () => {
  const announced = vi.fn();
  const stop = onUserBanned(announced);
  try {
    await prepareUserDeletion("u");
  } finally {
    stop();
  }
  expect(announced).toHaveBeenCalledWith("u", "application");
  expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u" } });
  expect(db.user.update.mock.invocationCallOrder[0]).toBeLessThan(
    announced.mock.invocationCallOrder[0]!,
  );
  expect(announced.mock.invocationCallOrder[0]).toBeLessThan(stopAll.mock.invocationCallOrder[0]!);
});

it("commits the ban and the session deletion together; a failed commit announces nothing", async () => {
  const announced = vi.fn();
  const stop = onUserBanned(announced);
  const transaction = prisma.$transaction as unknown as MockInstance;
  try {
    transaction.mockRejectedValueOnce(new Error("deadlock"));
    await expect(prepareUserDeletion("u")).rejects.toThrow("deadlock");
    expect(announced).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    // The ban and the deletion are one batch, not two independent writes.
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);
  } finally {
    stop();
  }
});
