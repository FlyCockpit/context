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
vi.mock("@cockpit-context/repos", async () => {
  const errors = await import("@cockpit-context/repos/errors");
  return {
    deleteRepository: remove,
    REQUEST_LOCK_WAIT_MS: 10_000,
    RepoError: errors.RepoError,
    isRepoError: errors.isRepoError,
    snapshotRefMissing: vi.fn(),
    cloneRepository: vi.fn(),
    updateSnapshotRepository: vi.fn(),
  };
});
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: () => ({ stopAllForOwner: stopAll }) }));
const cancelSnapshotSyncs = vi.hoisted(() => vi.fn());
vi.mock("./snapshot-tasks", () => ({ cancelSnapshotSyncs }));
vi.mock("@cockpit-context/runs/answer-reuse", () => ({ invalidateAnswersForOwner: forgetAnswers }));
const { default: prisma } = await import("@cockpit-context/db");
const db = prisma as unknown as {
  repository: { findMany: MockInstance };
  user: { findUnique: MockInstance; update: MockInstance; delete: MockInstance };
  $transaction: MockInstance;
};
const { prepareUserDeletion, stopUserRuns } = await import("./user-deletion");
const { onUserBanned } = await import("@cockpit-context/auth/ban");
beforeEach(() => {
  vi.clearAllMocks();
  db.repository.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ id: "u", role: "user" });
  db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) =>
    run(prisma),
  );
});
it("stops all the user's runs before removing only their private repository files", async () => {
  db.repository.findMany.mockResolvedValue([{ id: "repo-1" }]);
  await prepareUserDeletion("u");
  // Main AND summary runs, queued or running: one owner-scoped engine call.
  expect(stopAll.mock.calls).toEqual([["u"]]);
  expect(prisma.repository.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { ownerId: "u", visibility: "PRIVATE" }, take: 100 }),
  );
  expect(remove).toHaveBeenCalledWith("repo-1", { force: true, lockWaitMs: 10_000 });
  // Blocked (banned) first, so the engine refuses any launch still in flight.
  expect(db.user.update.mock.invocationCallOrder[0]).toBeLessThan(
    stopAll.mock.invocationCallOrder[0]!,
  );
  expect(stopAll.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
  expect(prisma.user.delete).not.toHaveBeenCalled();
});
it("kills the user's snapshot clones first, and a busy repository fails fast, leaving the ban", async () => {
  db.repository.findMany.mockResolvedValue([{ id: "repo-1" }, { id: "repo-2" }]);
  const { RepoError } = await import("@cockpit-context/repos/errors");
  remove.mockRejectedValueOnce(new RepoError("REPOSITORY_BUSY", "busy"));
  await expect(prepareUserDeletion("u")).rejects.toMatchObject({ code: "REPOSITORY_BUSY" });
  expect(cancelSnapshotSyncs).toHaveBeenCalledWith(["repo-1", "repo-2"]);
  expect(cancelSnapshotSyncs.mock.invocationCallOrder[0]).toBeLessThan(
    remove.mock.invocationCallOrder[0]!,
  );
  // Banned before anything else; nothing cascaded.
  expect(db.user.update).toHaveBeenCalled();
  expect(prisma.user.delete).not.toHaveBeenCalled();
});
it("shares one lock budget across all of the user's repositories", async () => {
  vi.useFakeTimers();
  try {
    db.repository.findMany.mockResolvedValue([
      { id: "repo-1" },
      { id: "repo-2" },
      { id: "repo-3" },
      { id: "repo-4" },
    ]);
    // Each delete waits its whole lock budget (and gets the lock just in time).
    remove.mockImplementation(
      (_id: string, options: { lockWaitMs: number }) =>
        new Promise((resolve) => setTimeout(() => resolve({ freedBytes: 0n }), options.lockWaitMs)),
    );
    const run = prepareUserDeletion("u");
    const settled = expect(run).rejects.toMatchObject({ code: "REPOSITORY_BUSY" });
    await vi.advanceTimersByTimeAsync(40_000);
    await settled;
    const waits = remove.mock.calls.map((call) => (call[1] as { lockWaitMs: number }).lockWaitMs);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30_000);
    // The fourth is never attempted: the budget is spent.
    expect(remove).toHaveBeenCalledTimes(3);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    remove.mockReset();
  }
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
  expect(prisma.$executeRaw).toHaveBeenCalled();
  expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u" } });
  expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
    where: { identifier: "archive-undo:u" },
  });
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
    // Neither write can escape the guarded transaction.
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
