import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dataDir: "" }));
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
    for (const dir of ["repos", "checkouts", "tmp"]) {
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
