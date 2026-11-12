import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectLspLanguages, lspWorkspaceDir } from "./detect";
import { LANGUAGE_SERVER_SPECS } from "./specs";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-context-lsp-detect-"));
  temps.push(root);
  for (const [relative, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), body);
  }
  return root;
}

describe("detectLspLanguages", () => {
  it("finds each language with its shallowest sample", () => {
    const root = tree({
      "packages/a/src/deep/index.ts": "",
      "src/index.ts": "",
      "tools/gen.py": "",
      "README.md": "",
    });
    expect(Object.fromEntries(detectLspLanguages(root))).toEqual({
      typescript: "src/index.ts",
      python: "tools/gen.py",
    });
  });

  it("counts JavaScript as the TypeScript server's language", () => {
    const root = tree({ "lib/index.mjs": "" });
    expect(Object.fromEntries(detectLspLanguages(root))).toEqual({ typescript: "lib/index.mjs" });
  });

  it("skips node_modules, dot directories and symlinks", () => {
    const root = tree({
      "node_modules/dep/index.js": "",
      ".venv/lib/site.py": "",
      "README.md": "",
    });
    fs.symlinkSync(path.join(root, "node_modules", "dep", "index.js"), path.join(root, "link.js"));
    expect(detectLspLanguages(root).size).toBe(0);
  });

  it("starts from a subdirectory when asked", () => {
    const root = tree({ "a.ts": "", "pkg/b.ts": "" });
    expect(detectLspLanguages(root, { start: "pkg" }).get("typescript")).toBe("pkg/b.ts");
  });
});

describe("lspWorkspaceDir", () => {
  it("uses the package subdirectory when it has its own project marker", () => {
    const root = tree({ "packages/core/package.json": "{}", "py/pyproject.toml": "" });
    expect(lspWorkspaceDir(root, "packages/core", LANGUAGE_SERVER_SPECS.typescript)).toBe(
      "packages/core",
    );
    expect(lspWorkspaceDir(root, "./py/", LANGUAGE_SERVER_SPECS.python)).toBe("py");
  });

  it("falls back to the checkout root", () => {
    const root = tree({ "packages/core/src/index.ts": "", "py/pyproject.toml": "" });
    expect(lspWorkspaceDir(root, undefined, LANGUAGE_SERVER_SPECS.typescript)).toBe(".");
    expect(lspWorkspaceDir(root, "packages/core", LANGUAGE_SERVER_SPECS.typescript)).toBe(".");
    // A Python marker does not make a TypeScript workspace.
    expect(lspWorkspaceDir(root, "py", LANGUAGE_SERVER_SPECS.typescript)).toBe(".");
    expect(lspWorkspaceDir(root, "missing", LANGUAGE_SERVER_SPECS.python)).toBe(".");
    expect(lspWorkspaceDir(root, "../..", LANGUAGE_SERVER_SPECS.python)).toBe(".");
  });
});
