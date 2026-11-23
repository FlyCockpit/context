import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/repos", async () => {
  const errors = await import("@cockpit-context/repos/errors");
  return {
    isRepoError: errors.isRepoError,
    snapshotRefMissing: () => new errors.RepoError("PACKAGE_SNAPSHOT_REF_MISSING", "missing"),
    cloneRepository: vi.fn(),
    updateSnapshotRepository: vi.fn(),
  };
});

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const tasks = await import("./snapshot-tasks");

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repository.updateMany).mockResolvedValue({ count: 1 });
});

describe("snapshot tasks", () => {
  it("runs one task per repository: a second start joins, cancel aborts and settles it", async () => {
    vi.mocked(repos.cloneRepository).mockImplementation(
      (_id, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    const input = { repositoryId: "repo-a", ownerId: "u", privateKey: "K", kind: "clone" as const };
    await expect(tasks.startSnapshotSync(input)).resolves.toEqual({ started: true });
    await expect(tasks.startSnapshotSync(input)).resolves.toEqual({ started: false });
    expect(tasks.snapshotSyncRunning("repo-a")).toBe(true);
    await settle();
    expect(repos.cloneRepository).toHaveBeenCalledTimes(1);
    // Returns at once: a request never waits for the clone to unwind.
    expect(tasks.cancelSnapshotSync("repo-a")).toBeUndefined();
    await tasks.snapshotSyncSettled("repo-a");
    expect(tasks.snapshotSyncRunning("repo-a")).toBe(false);
    expect(vi.mocked(prisma.repository.updateMany).mock.calls.at(-1)?.[0]).toEqual({
      where: { id: "repo-a", snapshotSyncStatus: "RUNNING" },
      data: { snapshotSyncStatus: "FAILED", snapshotSyncError: tasks.SNAPSHOT_CANCELLED },
    });
    // Free again: a new start runs.
    vi.mocked(repos.cloneRepository).mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof repos.cloneRepository>>,
    );
    await expect(tasks.startSnapshotSync(input)).resolves.toEqual({ started: true });
    await settle();
  });

  it("closes admission while a snapshot is converted: running task aborted, new ones refused", async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(repos.updateSnapshotRepository).mockImplementationOnce(
      (_id, _owner, _key, _deps, options) =>
        new Promise((_, reject) => {
          seen = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    const input = {
      repositoryId: "repo-c",
      ownerId: "u",
      privateKey: "K",
      kind: "refresh" as const,
    };
    await tasks.startSnapshotSync(input);
    await settle();
    let during: unknown;
    await tasks.withSnapshotTasksClosed("repo-c", async () => {
      expect(seen?.aborted).toBe(true);
      during = await tasks.startSnapshotSync(input).catch((error: unknown) => error);
    });
    expect(during).toMatchObject({ code: "PACKAGE_SNAPSHOT_REF_MISSING" });
    await tasks.snapshotSyncSettled("repo-c");
  });

  it("runs one package's snapshot operations one after the other", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = tasks.withSnapshotPackageGate("pkg-1", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = tasks.withSnapshotPackageGate("pkg-1", async () => {
      order.push("second");
    });
    const other = tasks.withSnapshotPackageGate("pkg-2", async () => {
      order.push("other");
    });
    await other;
    await settle();
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
    // A failure releases the gate too.
    await expect(
      tasks.withSnapshotPackageGate("pkg-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(tasks.withSnapshotPackageGate("pkg-1", async () => "next")).resolves.toBe("next");
  });

  it("refuses a row that is not the owner's snapshot, leaving nothing registered", async () => {
    vi.mocked(prisma.repository.updateMany).mockResolvedValueOnce({ count: 0 });
    await expect(
      tasks.startSnapshotSync({
        repositoryId: "repo-b",
        ownerId: "u",
        privateKey: "K",
        kind: "refresh",
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_SNAPSHOT_REF_MISSING" });
    expect(tasks.snapshotSyncRunning("repo-b")).toBe(false);
    expect(repos.updateSnapshotRepository).not.toHaveBeenCalled();
  });

  it("marks RUNNING rows no task of this process owns as interrupted (boot: no grace)", async () => {
    vi.mocked(prisma.repository.updateMany).mockResolvedValueOnce({ count: 2 });
    const before = Date.now();
    await expect(tasks.sweepStaleSnapshotSyncs(0)).resolves.toBe(2);
    const call = vi.mocked(prisma.repository.updateMany).mock.calls[0]?.[0];
    expect(call?.data).toEqual({
      snapshotSyncStatus: "FAILED",
      snapshotSyncError: tasks.SNAPSHOT_INTERRUPTED,
    });
    expect(call?.where).toMatchObject({ snapshotSyncStatus: "RUNNING", id: { notIn: [] } });
    const where = call?.where as
      | { OR: Array<{ snapshotSyncStartedAt: { lte: Date } | null }> }
      | undefined;
    const cutoff = where ? where.OR[1]?.snapshotSyncStartedAt : null;
    expect(cutoff && "lte" in cutoff ? cutoff.lte.getTime() : 0).toBeGreaterThanOrEqual(before);
  });
});
