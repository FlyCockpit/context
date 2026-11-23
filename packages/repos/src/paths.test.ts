import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dataDir: "", renameError: null as Error | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (from: string, to: string) => {
      const error = state.renameError;
      state.renameError = null;
      return error ? Promise.reject(error) : actual.rename(from, to);
    },
  };
});
vi.mock("./config", () => ({ dataDir: () => state.dataDir, gitHostAllowlist: () => [] }));

const paths = await import("./paths");

beforeAll(async () => {
  state.dataDir = await mkdtemp(path.join(tmpdir(), "cockpit-context-paths-"));
});

afterAll(async () => {
  await rm(state.dataDir, { recursive: true, force: true });
});

describe("storage layout", () => {
  it("builds paths from validated ids only", () => {
    const sha = "a".repeat(40);
    expect(paths.repositoryDir("cmabc12345")).toBe(
      path.join(state.dataDir, "repos", "cmabc12345.git"),
    );
    expect(paths.checkoutDir("cmabc12345", sha)).toBe(
      path.join(state.dataDir, "checkouts", "cmabc12345", sha),
    );
    expect(() => paths.repositoryDir("../../etc")).toThrow();
    expect(() => paths.checkoutDir("cmabc12345", "HEAD")).toThrow();
  });

  it("creates 0700 roots", async () => {
    await paths.ensureDataDirs();
    for (const dir of ["repos", "checkouts", "tmp", "repos/.trash", "checkouts/.trash"]) {
      expect((await stat(path.join(state.dataDir, dir))).mode & 0o777).toBe(0o700);
    }
  });
});

describe("removeInsideDataDir", () => {
  it("refuses the roots themselves and anything outside", async () => {
    await expect(paths.removeInsideDataDir(paths.reposRoot())).rejects.toThrow(/outside/);
    await expect(paths.removeInsideDataDir(state.dataDir)).rejects.toThrow(/outside/);
    await expect(paths.removeInsideDataDir("/tmp")).rejects.toThrow(/outside/);
    await expect(
      paths.removeInsideDataDir(path.join(paths.reposRoot(), "..", "..", "x")),
    ).rejects.toThrow(/outside/);
  });
});

describe("sweepTmpDir", () => {
  it("removes leftovers from crashed invocations", async () => {
    const leftover = await paths.makeInvocationTmpDir();
    await writeFile(path.join(leftover, "id"), "secret", { mode: 0o600 });
    await mkdir(path.join(paths.tmpRoot(), "other"), { recursive: true });
    await expect(paths.sweepTmpDir()).resolves.toBe(2);
    expect(await readdir(paths.tmpRoot())).toEqual([]);
  });
});

describe("moveToTrash / sweepTrash", () => {
  const trashEntries = async () =>
    (await Promise.all(paths.trashRoots().map((root) => readdir(root).catch(() => [])))).flat();

  it("renames a clone out of service in one step, then the sweep removes the files", async () => {
    const repo = paths.repositoryDir("cmtrash0001");
    await mkdir(path.join(repo, "objects"), { recursive: true });
    await writeFile(path.join(repo, "objects", "pack"), "x");
    await paths.moveToTrash(repo);
    await expect(stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
    // Into its own root's trash: the rename never crosses filesystems.
    expect(paths.trashRoots()[0]).toBe(path.join(state.dataDir, "repos", ".trash"));
    // The background sweep the move scheduled (single flight: this joins it).
    await paths.sweepTrash();
    expect(await trashEntries()).toEqual([]);
  });

  it("accepts a missing target and refuses anything outside the clone and checkout roots", async () => {
    await expect(paths.moveToTrash(paths.repositoryDir("cmmissing01"))).resolves.toBeUndefined();
    await expect(paths.moveToTrash(state.dataDir)).rejects.toThrow(/outside/);
    await expect(paths.moveToTrash(path.join(paths.tmpRoot(), "x"))).rejects.toThrow(/outside/);
    await expect(paths.moveToTrash(paths.trashRoots()[0] as string)).rejects.toThrow(/trash/);
  });

  it("keeps two deletions of the same checkout path apart in the trash", async () => {
    const dir = paths.checkoutDir("cmtrash0002", "a".repeat(40));
    await mkdir(dir, { recursive: true });
    await paths.moveToTrash(dir);
    await mkdir(dir, { recursive: true });
    await paths.moveToTrash(dir);
    await paths.sweepTrash();
    expect(await trashEntries()).toEqual([]);
  });

  it("refuses at once, never removing in place, when the rename fails (a mount point)", async () => {
    const dir = paths.checkoutDir("cmtrash0003", "b".repeat(40));
    await mkdir(dir, { recursive: true });
    state.renameError = Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    await expect(paths.moveToTrash(dir)).rejects.toMatchObject({ code: "EXDEV" });
    // Still there: nothing was removed synchronously.
    await expect(stat(dir)).resolves.toBeTruthy();
  });
});
