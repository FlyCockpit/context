import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildCommit } from "./build-commit.js";

describe("readBuildCommit", () => {
  const dirs: string[] = [];
  const bundleIn = (content?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "build-commit-"));
    dirs.push(dir);
    if (content !== undefined) writeFileSync(path.join(dir, "BUILD_COMMIT"), content);
    return path.join(dir, "index.mjs");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the full SHA written next to the bundle", () => {
    expect(readBuildCommit(bundleIn(`${"A".repeat(40)}\n`))).toBe("a".repeat(40));
  });

  it("reports null when the file is missing, empty, or not a full SHA", () => {
    expect(readBuildCommit(bundleIn())).toBeNull();
    expect(readBuildCommit(bundleIn(""))).toBeNull();
    expect(readBuildCommit(bundleIn("abc1234"))).toBeNull();
    expect(readBuildCommit(undefined)).toBeNull();
  });
});
