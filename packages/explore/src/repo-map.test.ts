import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatRepoMapForPrompt, generateRepoMap } from "./repo-map";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("generateRepoMap", () => {
  it("detects languages, examples, and manifests", async () => {
    const root = tempDir("cockpit-context-map-");
    fs.writeFileSync(path.join(root, "README.md"), "# hello\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
    fs.mkdirSync(path.join(root, "examples"));
    fs.writeFileSync(path.join(root, "examples", "basic.ts"), "export {}\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1\n");

    const map = await generateRepoMap(root);
    expect(map.languages).toContain("typescript");
    expect(map.examplePaths).toContain("examples");
    expect(map.manifests).toContain("package.json");
    expect(map.entrypoints).toContain("README.md");
    expect(formatRepoMapForPrompt(map)).toContain("examplePaths");
  });

  it("lists real workspace packages in order", async () => {
    const root = tempDir("cockpit-context-map-");
    for (const name of ["zeta", "alpha", ".hidden"]) {
      fs.mkdirSync(path.join(root, "packages", name), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "packages", "alpha", "package.json"), "{}\n");
    const map = await generateRepoMap(root);
    expect(map.notablePackages).toEqual(["packages/alpha", "packages/zeta"]);
    expect(map.entrypoints).toContain("packages");
    expect(map.manifests).toEqual(["packages/alpha/package.json"]);
  });

  it("never follows a symlinked workspace or entry out of the root", async () => {
    // A directory outside the checkout whose names must not leak (other repos' ids).
    const outside = tempDir("cockpit-context-host-");
    fs.mkdirSync(path.join(outside, "secret-repo-id"));
    fs.mkdirSync(path.join(outside, "src"));
    fs.writeFileSync(path.join(outside, "README.md"), "host\n");
    fs.writeFileSync(path.join(outside, "src", "index.ts"), "export {}\n");

    const root = tempDir("cockpit-context-map-");
    fs.symlinkSync(outside, path.join(root, "packages"), "dir");
    fs.symlinkSync(outside, path.join(root, "crates"), "dir");
    fs.symlinkSync(path.join(outside, "src"), path.join(root, "src"), "dir");
    fs.symlinkSync(path.join(outside, "README.md"), path.join(root, "docs"));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "index.ts"), "export {}\n");

    const map = await generateRepoMap(root);
    const rendered = JSON.stringify(map);
    expect(rendered).not.toContain("secret-repo-id");
    expect(map.notablePackages).toEqual([]);
    // Links are never walked into: nothing behind them is listed.
    expect(map.entrypoints).toContain("lib/index.ts");
    expect(map.entrypoints).not.toContain("src/index.ts");
    expect(map.manifests).toEqual([]);
    expect(map.languages).toEqual(["typescript"]);
    expect(map.topLevel).toEqual(["lib"]);
    expect(map.docPaths).toEqual([]);
  });

  it("does not reach an entry through a symlinked parent directory", async () => {
    const outside = tempDir("cockpit-context-host-");
    fs.writeFileSync(path.join(outside, "index.ts"), "export {}\n");
    fs.writeFileSync(path.join(outside, "lib.rs"), "\n");
    const root = tempDir("cockpit-context-map-");
    fs.symlinkSync(outside, path.join(root, "src"), "dir");
    const map = await generateRepoMap(root);
    expect(map.entrypoints).toEqual([]);
  });
});

describe("generateRepoMap on the sample-pkg fixture", () => {
  it("finds the example directory and the TypeScript sources", async () => {
    const root = path.resolve(import.meta.dirname, "../fixtures/sample-pkg");
    const map = await generateRepoMap(root);
    expect(map.rootName).toBe("sample-pkg");
    expect(map.languages).toEqual(["typescript"]);
    expect(map.examplePaths).toEqual(["examples"]);
    expect(map.topLevel).toEqual(["examples", "src"]);
    expect(map.hints.some((hint) => hint.includes("examplePaths"))).toBe(true);
  });

  it("bounds the prompt rendering", async () => {
    const root = path.resolve(import.meta.dirname, "../fixtures/sample-pkg");
    const rendered = formatRepoMapForPrompt(await generateRepoMap(root), 40);
    expect(rendered.length).toBeLessThanOrEqual(40 + "\n…[truncated]".length);
    expect(rendered.endsWith("…[truncated]")).toBe(true);
  });
});
