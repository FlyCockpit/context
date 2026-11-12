import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pass-through lstat that records how many calls overlap.
const probe = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await actual.lstat(...args);
      } finally {
        probe.inFlight -= 1;
      }
    },
  };
});

const { measureDirectory } = await import("./storage");

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-storage-"));
  await mkdir(path.join(root, "a", "b"), { recursive: true });
  await writeFile(path.join(root, "a", "one.txt"), "x".repeat(1_000));
  await writeFile(path.join(root, "a", "b", "two.txt"), "y".repeat(2_000));
  // A symlink to / must count as a link, never be followed.
  await symlink("/", path.join(root, "a", "escape"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("measureDirectory", () => {
  it("sums file sizes without following symlinks", async () => {
    const result = await measureDirectory(root);
    expect(result.truncated).toBe(false);
    expect(result.entries).toBe(5);
    expect(result.bytes).toBeGreaterThanOrEqual(3_000n);
    expect(result.bytes).toBeLessThan(1_000_000n);
  });

  it("stops at the entry bound and says so", async () => {
    const result = await measureDirectory(root, { maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.entries).toBe(2);
  });

  it("stops at the depth bound and says so", async () => {
    const result = await measureDirectory(root, { maxDepth: 1 });
    expect(result.truncated).toBe(true);
  });

  it("overlaps lstats with a bound and counts the same total as a sequential walk", async () => {
    const wide = path.join(root, "wide");
    let expected = 0n;
    let files = 0;
    for (let dir = 0; dir < 4; dir += 1) {
      await mkdir(path.join(wide, `d${dir}`, "nested"), { recursive: true });
      for (let file = 0; file < 40; file += 1) {
        const size = dir * 100 + file + 1;
        await writeFile(path.join(wide, `d${dir}`, `f${file}`), "z".repeat(size));
        await writeFile(path.join(wide, `d${dir}`, "nested", `f${file}`), "z".repeat(size));
        expected += BigInt(size * 2);
        files += 2;
      }
    }
    const { lstat: realLstat, readdir } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // Directory sizes are filesystem-specific: add them as the walk sees them.
    const dirs = [wide];
    for (let dir = 0; dir < 4; dir += 1) {
      dirs.push(path.join(wide, `d${dir}`), path.join(wide, `d${dir}`, "nested"));
    }
    for (const dir of dirs) expected += BigInt((await realLstat(dir)).size);
    expect((await readdir(wide)).length).toBe(4);

    probe.maxInFlight = 0;
    const result = await measureDirectory(wide);
    expect(result).toEqual({ bytes: expected, entries: files + 8, truncated: false });
    expect(probe.maxInFlight).toBeGreaterThan(1);
    expect(probe.maxInFlight).toBeLessThanOrEqual(32);
    expect(probe.inFlight).toBe(0);
  });

  it("stops at the entry bound with every started lstat settled", async () => {
    const result = await measureDirectory(path.join(root, "wide"), { maxEntries: 50 });
    expect(result).toMatchObject({ entries: 50, truncated: true });
    expect(probe.inFlight).toBe(0);
  });

  it("measures a missing directory as zero", async () => {
    await expect(measureDirectory(path.join(root, "missing"))).resolves.toEqual({
      bytes: 0n,
      entries: 0,
      truncated: false,
    });
  });
});
