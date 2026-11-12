import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeCheckoutRow } from "./test-support/fake-git-db";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const state = vi.hoisted(() => ({
  dataDir: "",
  remoteDir: "",
  fail: false,
  connects: 0,
  // Thrown by the next connect instead of running git (a timeout, a policy refusal).
  failWith: null as unknown,
  // Runs at each connect, before it fails or proceeds: a concurrent writer.
  onConnect: null as (() => void) | null,
}));
vi.mock("./config", () => ({
  dataDir: () => state.dataDir,
  fetchIntervalMs: () => 300_000,
  gitHostAllowlist: () => [],
}));
vi.mock("./network", () => ({
  withGitNetwork: async (_spec: unknown, fn: (network: unknown) => Promise<unknown>) => {
    state.connects += 1;
    state.onConnect?.();
    if (state.fail) throw Object.assign(new Error("connect refused"), { code: "GIT_FAILED" });
    if (state.failWith) throw state.failWith;
    return fn({
      config: [
        "protocol.file.allow=always",
        `url.file://${state.remoteDir}.insteadOf=https://example.com/o/r`,
      ],
      env: {},
    });
  },
}));

const { default: prisma } = await import("@cockpit-context/db");
const { installFakeRows } = await import("./test-support/fake-git-db");
const { createFixtureRepo, fixtureGit } = await import("./test-support/fixture-repo");
const { ensureRepository } = await import("./repositories");
const { deleteCheckout, ensureCheckout, materializeCheckout } = await import("./checkouts");
const { onCheckoutRemoval } = await import("./removal-hooks");
const { deleteRepository } = await import("./repositories");
const { repositoryDir } = await import("./paths");

const { GitCommandError } = await import("./git-exec");

const db = prisma as unknown as Parameters<typeof installFakeRows>[0];

let root: string;
let shas: Awaited<ReturnType<typeof createFixtureRepo>>["shas"];
let fake: ReturnType<typeof installFakeRows>;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-checkouts-"));
  const fixture = await createFixtureRepo(path.join(root, "fixture"));
  state.remoteDir = fixture.workDir;
  shas = fixture.shas;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.fail = false;
  state.failWith = null;
  state.onConnect = null;
  state.connects = 0;
  state.dataDir = await mkdtemp(path.join(root, "data-"));
  fake = installFakeRows(db);
  // The conditional FAILED write after a clone failure.
  db.checkout.updateMany?.mockImplementation(
    async (args: {
      where: { id: string; status: { not: "READY" } };
      data: Partial<FakeCheckoutRow>;
    }) => {
      const row = fake.checkouts.get(args.where.id);
      if (!row || row.status === args.where.status.not) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
  );
});

async function cloned() {
  return ensureRepository({ gitUrl: "https://example.com/o/r", ownerId: "user-1" });
}

describe("ensureCheckout", () => {
  it("creates a detached worktree at the commit and marks it READY", async () => {
    const repo = await cloned();
    const checkout = await ensureCheckout({
      repositoryId: repo.id,
      sha: shas.two,
      resolvedFrom: "tag:v1.2.0",
    });
    expect(checkout).toMatchObject({
      status: "READY",
      sha: shas.two,
      resolvedFrom: "tag:v1.2.0",
      lastError: null,
    });
    expect(checkout.path).toBe(path.join(state.dataDir, "checkouts", repo.id, shas.two));
    expect(await readFile(path.join(checkout.path, "packages/pkg/index.ts"), "utf8")).toBe(
      "export const two = 2;\n",
    );
    // Detached at the commit; later commits are absent.
    await expect(stat(path.join(checkout.path, "src/four.ts"))).rejects.toThrow();
    expect(await fixtureGit(checkout.path, "rev-parse", "HEAD")).toBe(shas.two);
    expect(checkout.diskBytes).toBeGreaterThan(0n);
  });

  it("lazily fetches the commit's blobs into the blobless clone", async () => {
    const repo = await cloned();
    const gitDir = repositoryDir(repo.id);
    const missingBefore = await fixtureGit(
      gitDir,
      "rev-list",
      "--objects",
      "--missing=print",
      shas.one,
    );
    expect(missingBefore).toMatch(/^\?/m);
    await ensureCheckout({ repositoryId: repo.id, sha: shas.one });
    const missingAfter = await fixtureGit(
      gitDir,
      "rev-list",
      "--objects",
      "--missing=print",
      shas.one,
    );
    expect(missingAfter).not.toMatch(/^\?/m);
  });

  it("is idempotent for a READY checkout", async () => {
    const repo = await cloned();
    const first = await ensureCheckout({ repositoryId: repo.id, sha: shas.one });
    const second = await ensureCheckout({ repositoryId: repo.id, sha: shas.one });
    expect(second.id).toBe(first.id);
    expect(fake.checkouts.size).toBe(1);
  });

  it("re-creates a worktree that was removed from disk", async () => {
    const repo = await cloned();
    const first = await ensureCheckout({ repositoryId: repo.id, sha: shas.one });
    await rm(first.path, { recursive: true });
    const again = await materializeCheckout(first.id);
    expect((await stat(path.join(again.path, "README.md"))).isFile()).toBe(true);
  });

  it("re-clones a pruned repository first", async () => {
    const repo = await cloned();
    await rm(repositoryDir(repo.id), { recursive: true });
    const checkout = await ensureCheckout({ repositoryId: repo.id, sha: shas.feature });
    expect((await stat(path.join(checkout.path, "feature.txt"))).isFile()).toBe(true);
  });

  it("fails a commit that is not in the repository", async () => {
    const repo = await cloned();
    await expect(
      ensureCheckout({ repositoryId: repo.id, sha: "f".repeat(40) }),
    ).rejects.toMatchObject({
      code: "REF_NOT_FOUND",
    });
    const [row] = fake.checkouts.values();
    expect(row?.status).toBe("FAILED");
  });

  it("fetches a commit only the server has by id, then checks it out", async () => {
    const repo = await cloned();
    const tree = await fixtureGit(state.remoteDir, "rev-parse", `${shas.two}^{tree}`);
    const prSha = await fixtureGit(state.remoteDir, "commit-tree", tree, "-m", "pr only");
    await fixtureGit(state.remoteDir, "update-ref", "refs/pull/3/head", prSha);
    try {
      state.connects = 0;
      const checkout = await ensureCheckout({ repositoryId: repo.id, sha: prSha });
      expect(checkout.status).toBe("READY");
      expect(await fixtureGit(checkout.path, "rev-parse", "HEAD")).toBe(prSha);
      // The fetch by id, then the worktree add (lazy blobs), each pinned.
      expect(state.connects).toBe(2);
    } finally {
      await fixtureGit(state.remoteDir, "update-ref", "-d", "refs/pull/3/head");
    }
  });

  it("marks the checkout FAILED when the repository cannot be cloned", async () => {
    const repo = await cloned();
    await rm(repositoryDir(repo.id), { recursive: true });
    state.fail = true;
    await expect(ensureCheckout({ repositoryId: repo.id, sha: shas.two })).rejects.toThrow(
      "connect refused",
    );
    const [row] = fake.checkouts.values();
    expect(row).toMatchObject({ status: "FAILED", lastError: "connect refused" });
  });

  it("never fails a checkout a concurrent materialization made READY while its clone failed", async () => {
    const repo = await cloned();
    await rm(repositoryDir(repo.id), { recursive: true });
    state.fail = true;
    // The other materialization wins while this one's clone is failing.
    state.onConnect = () => {
      for (const row of fake.checkouts.values()) Object.assign(row, { status: "READY" });
    };
    await expect(ensureCheckout({ repositoryId: repo.id, sha: shas.two })).rejects.toThrow(
      "connect refused",
    );
    const [row] = fake.checkouts.values();
    expect(row).toMatchObject({ status: "READY", lastError: null });
    expect(db.checkout.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("reports a fetch by id that timed out as itself, not as a missing commit", async () => {
    const repo = await cloned();
    const timeout = new GitCommandError("GIT_TIMEOUT", "git fetch timed out after 120s.", null, "");
    state.failWith = timeout;
    await expect(ensureCheckout({ repositoryId: repo.id, sha: "e".repeat(40) })).rejects.toBe(
      timeout,
    );
    const [row] = fake.checkouts.values();
    expect(row).toMatchObject({ status: "FAILED", lastError: "git fetch timed out after 120s." });
  });

  it("refuses a non-SHA", async () => {
    const repo = await cloned();
    await expect(ensureCheckout({ repositoryId: repo.id, sha: "main" })).rejects.toThrow(/40-hex/);
  });
});

describe("deleteCheckout", () => {
  it("removes the worktree and git's record of it", async () => {
    const repo = await cloned();
    const checkout = await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
    const result = await deleteCheckout(checkout.id);
    expect(result.freedBytes).toBe(checkout.diskBytes);
    await expect(stat(checkout.path)).rejects.toThrow();
    const list = await fixtureGit(repositoryDir(repo.id), "worktree", "list", "--porcelain");
    expect(list).not.toContain(shas.two);
    expect(fake.checkouts.size).toBe(0);
  });

  it("tells removal listeners (the LSP manager) before the worktree goes", async () => {
    const repo = await cloned();
    const checkout = await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
    const seen: Array<{ ids: readonly string[]; worktreeStillThere: boolean }> = [];
    const off = onCheckoutRemoval(async (ids) => {
      const worktreeStillThere = await stat(checkout.path).then(
        () => true,
        () => false,
      );
      seen.push({ ids, worktreeStillThere });
    });
    try {
      await deleteCheckout(checkout.id);
    } finally {
      off();
    }
    expect(seen).toEqual([{ ids: [checkout.id], worktreeStillThere: true }]);
  });

  it("deleting the repository tells removal listeners about every checkout", async () => {
    const repo = await cloned();
    const one = await ensureCheckout({ repositoryId: repo.id, sha: shas.one });
    const two = await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
    const seen: string[] = [];
    const off = onCheckoutRemoval((ids) => {
      seen.push(...ids);
    });
    try {
      await deleteRepository(repo.id, { force: true });
    } finally {
      off();
    }
    expect(seen.sort()).toEqual([one.id, two.id].sort());
  });

  it("refuses a leased checkout unless forced", async () => {
    const repo = await cloned();
    const checkout = await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
    db.checkoutLease.count?.mockResolvedValue(1);
    await expect(deleteCheckout(checkout.id)).rejects.toMatchObject({ code: "CHECKOUT_LEASED" });
    expect((await stat(checkout.path)).isDirectory()).toBe(true);
    await deleteCheckout(checkout.id, { force: true });
    await expect(stat(checkout.path)).rejects.toThrow();
  });

  it("is CHECKOUT_NOT_FOUND for an unknown id", async () => {
    await expect(deleteCheckout("chk-missing-1")).rejects.toMatchObject({
      code: "CHECKOUT_NOT_FOUND",
    });
  });
});
