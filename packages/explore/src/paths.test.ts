import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWithinRoot, toRelativeRootPath } from "./paths";

const temps: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-context-explore-"));
  temps.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWithinRoot", () => {
  it("resolves relative paths inside the root", () => {
    const root = makeRoot();
    expect(resolveWithinRoot(root, "src/index.ts")).toBe(
      fs.realpathSync.native(path.join(root, "src", "index.ts")),
    );
  });

  it("rejects lexical escapes", () => {
    const root = makeRoot();
    expect(() => resolveWithinRoot(root, "../outside")).toThrow(/escapes explore root/);
  });

  it("rejects symlink escapes", () => {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-context-explore-out-"));
    temps.push(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope\n");
    fs.symlinkSync(outside, path.join(root, "link-out"));
    expect(() => resolveWithinRoot(root, "link-out/secret.txt")).toThrow(/escapes explore root/);
  });
});

describe("toRelativeRootPath", () => {
  it("returns posix-style relative paths", () => {
    const root = makeRoot();
    const absolute = path.join(root, "src", "index.ts");
    expect(toRelativeRootPath(root, absolute)).toBe("src/index.ts");
  });
});
