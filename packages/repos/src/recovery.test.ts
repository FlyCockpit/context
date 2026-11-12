import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const state = vi.hoisted(() => ({ dataDir: "" }));
vi.mock("./config", () => ({
  dataDir: () => state.dataDir,
  fetchIntervalMs: () => 300_000,
  gitHostAllowlist: () => [],
}));

const { default: prisma } = await import("@cockpit-context/db");
const { INTERRUPTED_BY_RESTART, recoverInterruptedGitWork } = await import("./recovery");

const db = prisma as unknown as {
  repository: { updateMany: ReturnType<typeof vi.fn> };
  checkout: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const REPO = "repo0000000001";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const now = new Date("2026-11-04T12:00:00Z");

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-recovery-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.dataDir = await mkdtemp(path.join(root, "data-"));
  db.repository.updateMany.mockResolvedValue({ count: 0 });
  db.checkout.findMany.mockResolvedValue([]);
  db.checkout.count.mockResolvedValue(1);
  db.checkout.updateMany.mockResolvedValue({ count: 1 });
});

describe("recoverInterruptedGitWork", () => {
  it("fails repositories a crash left CLONING", async () => {
    db.repository.updateMany.mockResolvedValue({ count: 2 });
    const result = await recoverInterruptedGitWork({ now: () => now });
    expect(result.repositories).toBe(2);
    expect(db.repository.updateMany).toHaveBeenCalledWith({
      where: { status: "CLONING" },
      data: { status: "FAILED", lastError: INTERRUPTED_BY_RESTART },
    });
  });

  it("removes clone staging directories and nothing else", async () => {
    const repos = path.join(state.dataDir, "repos");
    await mkdir(path.join(repos, `${REPO}.git`), { recursive: true });
    await mkdir(path.join(repos, `${REPO}.git.clone-0123456789ab`, "objects"), {
      recursive: true,
    });
    await mkdir(path.join(repos, `${REPO}.git.clone-ffffffffffff`));
    await writeFile(path.join(repos, "notes.txt"), "keep");
    await mkdir(path.join(repos, `${REPO}.git.clone-short`));
    const result = await recoverInterruptedGitWork({ now: () => now });
    expect(result.stagingDirs).toBe(2);
    expect((await readdir(repos)).sort()).toEqual(
      [`${REPO}.git`, `${REPO}.git.clone-short`, "notes.txt"].sort(),
    );
  });

  it("tolerates a data directory that does not exist yet", async () => {
    await expect(recoverInterruptedGitWork({ now: () => now })).resolves.toEqual({
      repositories: 0,
      stagingDirs: 0,
      checkouts: 0,
    });
  });

  it("fails unleased PENDING checkouts and removes their partial worktrees", async () => {
    const partial = path.join(state.dataDir, "checkouts", REPO, SHA);
    const kept = path.join(state.dataDir, "checkouts", REPO, OTHER_SHA);
    await mkdir(path.join(partial, "src"), { recursive: true });
    await writeFile(path.join(partial, "src", "half.ts"), "export const half");
    await mkdir(kept, { recursive: true });
    db.checkout.findMany
      .mockResolvedValueOnce([
        { id: "chk0000000001", repositoryId: REPO, sha: SHA },
        { id: "chk0000000002", repositoryId: REPO, sha: OTHER_SHA },
      ])
      .mockResolvedValueOnce([]);
    // The second one was leased (or finished) by the time the lock was taken.
    db.checkout.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const result = await recoverInterruptedGitWork({ now: () => now });

    expect(result.checkouts).toBe(1);
    const unleasedPending = {
      status: "PENDING",
      Leases: { none: { expiresAt: { gt: now } } },
    };
    expect(db.checkout.findMany).toHaveBeenNthCalledWith(1, {
      where: unleasedPending,
      orderBy: { id: "asc" },
      select: { id: true, repositoryId: true, sha: true },
      take: 100,
    });
    expect(db.checkout.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { ...unleasedPending, id: { gt: "chk0000000002" } } }),
    );
    expect(db.checkout.updateMany).toHaveBeenCalledOnce();
    expect(db.checkout.updateMany).toHaveBeenCalledWith({
      where: { id: "chk0000000001", ...unleasedPending },
      data: { status: "FAILED", lastError: INTERRUPTED_BY_RESTART, diskBytes: 0n },
    });
    await expect(stat(partial)).rejects.toThrow();
    expect((await stat(kept)).isDirectory()).toBe(true);
  });

  it("keeps going when one checkout cannot be recovered", async () => {
    db.checkout.findMany
      .mockResolvedValueOnce([
        { id: "chk0000000001", repositoryId: REPO, sha: SHA },
        { id: "chk0000000002", repositoryId: REPO, sha: OTHER_SHA },
      ])
      .mockResolvedValueOnce([]);
    db.checkout.updateMany
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce({ count: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await recoverInterruptedGitWork({ now: () => now });
      expect(result.checkouts).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
