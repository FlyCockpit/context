import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exploreGlob, exploreGlobAsync, exploreGrepJs, exploreRead } from "./fs-ops";

const temps: string[] = [];

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-context-explore-ops-"));
  temps.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "examples"));
  fs.writeFileSync(
    path.join(root, "src", "api.ts"),
    ["export function greet(name: string) {", '  return "hello " + name;', "}", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "examples", "basic.ts"),
    'import { greet } from "../src/api";\nconsole.log(greet("world"));\n',
  );
  fs.mkdirSync(path.join(root, "node_modules", "leftpad"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("exploreGlob", { timeout: 30_000 }, () => {
  it("finds source files and skips node_modules", () => {
    const root = makeFixture();
    const result = exploreGlob(root, "**/*.ts");
    expect(result.matches).toEqual(["examples/basic.ts", "src/api.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("refuses absolute and parent-climbing patterns", () => {
    const root = makeFixture();
    expect(() => exploreGlob(root, "/etc/*")).toThrow(/relative to the explore root/);
    expect(() => exploreGlob(root, "../**/*")).toThrow(/relative to the explore root/);
    expect(() => exploreGlob(root, "src/../../*")).toThrow(/relative to the explore root/);
    expect(() => exploreGlob(root, "{..,x}/**/*")).toThrow(/relative to the explore root/);
    expect(() => exploreGlob(root, "src/{a,..}/*")).toThrow(/relative to the explore root/);
  });

  it("supports literal prefixes, braces, dotfiles named explicitly, and searchPath", () => {
    const root = makeFixture();
    fs.mkdirSync(path.join(root, ".github"));
    fs.writeFileSync(path.join(root, ".github", "ci.yml"), "x\n");
    fs.writeFileSync(path.join(root, "src", "util.tsx"), "x\n");
    expect(exploreGlob(root, "src/*.ts").matches).toEqual(["src/api.ts"]);
    expect(exploreGlob(root, "./src/api.ts").matches).toEqual(["src/api.ts"]);
    expect(exploreGlob(root, "**/*.{ts,tsx}").matches).toEqual([
      "examples/basic.ts",
      "src/api.ts",
      "src/util.tsx",
    ]);
    expect(exploreGlob(root, "**/*.yml").matches).toEqual([]);
    expect(exploreGlob(root, ".github/*").matches).toEqual([".github/ci.yml"]);
    expect(exploreGlob(root, "*.ts", "src").matches).toEqual(["src/api.ts"]);
    expect(exploreGlob(root, "missing/**/*").matches).toEqual([]);
  });

  it("never walks through a symlinked directory or lists a symlinked file", () => {
    const root = makeFixture();
    fs.mkdirSync(path.join(root, "sub"));
    fs.symlinkSync("/", path.join(root, "sub", "rootlink"));
    fs.symlinkSync(path.join(root, "src"), path.join(root, "sub", "loop"));
    fs.symlinkSync(path.join(root, "src", "api.ts"), path.join(root, "sub", "link.ts"));
    const started = Date.now();
    expect(() => exploreGlob(root, "sub/rootlink/usr/**/*.h")).toThrow(
      /^Path escapes explore root: sub\/rootlink\/usr$/,
    );
    expect(exploreGlob(root, "sub/**/*").matches).toEqual([]);
    expect(exploreGlob(root, "**/*.ts").matches).toEqual(["examples/basic.ts", "src/api.ts"]);
    expect(exploreGlob(root, "{src,sub/loop}/*.ts").matches).toEqual(["src/api.ts"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("prunes by pattern shape, so a large earlier sibling cannot starve a shallow pattern", () => {
    const root = makeFixture();
    // More entries than the visit cap, in a directory that sorts before the matches.
    fs.mkdirSync(path.join(root, "a"));
    for (let i = 0; i < 50_001; i += 1) {
      fs.writeFileSync(path.join(root, "a", `f${i}.ts`), "");
    }
    // A dot directory `**` cannot match: the walk must not spend visits there.
    fs.mkdirSync(path.join(root, ".cache"));
    fs.writeFileSync(path.join(root, ".cache", "x.ts"), "");
    fs.writeFileSync(path.join(root, "z.ts"), "");
    fs.writeFileSync(path.join(root, "tsconfig.base.json"), "{}");
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");

    expect(exploreGlob(root, "*.ts")).toEqual({ matches: ["z.ts"], truncated: false });
    expect(exploreGlob(root, "z.ts")).toEqual({ matches: ["z.ts"], truncated: false });
    expect(exploreGlob(root, "tsconfig*.json")).toEqual({
      matches: ["tsconfig.base.json", "tsconfig.json"],
      truncated: false,
    });
    expect(exploreGlob(root, "[es]*/*.ts")).toEqual({
      matches: ["examples/basic.ts", "src/api.ts"],
      truncated: false,
    });
    expect(exploreGlob(root, "{examples,src}/**/*.ts")).toEqual({
      matches: ["examples/basic.ts", "src/api.ts"],
      truncated: false,
    });
    // Unprunable shapes still walk everything and report the cap honestly.
    expect(exploreGlob(root, "**/*.ts").truncated).toBe(true);
    // Writing 50 001 files takes seconds on a loaded runner (the package's
    // real language-server tests run alongside); 5 s is too tight for the fixture.
  }, 60_000);

  it("enters a dot directory under ** only when a later segment names it", () => {
    const root = makeFixture();
    fs.mkdirSync(path.join(root, "pkg", ".github"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", ".github", "ci.yml"), "x\n");
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, ".hidden", "ci.yml"), "x\n");
    expect(exploreGlob(root, "**/*.yml").matches).toEqual([]);
    expect(exploreGlob(root, "**/.github/*.yml").matches).toEqual(["pkg/.github/ci.yml"]);
    expect(exploreGlob(root, ".*/*.yml").matches).toEqual([".hidden/ci.yml"]);
  });

  it("matches exactly what path.matchesGlob over a full walk would", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-context-explore-glob-"));
    temps.push(root);
    const files = [
      "src/api.ts",
      "src/b.ts",
      "src/c.tsx",
      "src/x.js",
      "src/index.ts",
      "src/.eslintrc",
      "src/nested/deep/index.ts",
      "src/nested/util.js",
      "src/.config/a.json",
      "lib/a/x.ts",
      "lib/b/c/y.ts",
      "lib/b/z.ts",
      ".github/workflows/ci.yml",
      ".prettierrc",
      "README.md",
      "Upper.TS",
      "node_modules/m/index.ts",
    ];
    for (const file of files) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "");
    }
    const listed = files.filter((file) => !file.startsWith("node_modules/"));
    const patterns = [
      "**",
      "*",
      "*/*",
      "**/*.{ts,tsx}",
      "src/**",
      "src/**/index.ts",
      "**/index.ts",
      ".*",
      "**/.*",
      "**/.*rc",
      "src/.*/*.json",
      "src/**/.config/*.json",
      "src/[a-c]*.ts",
      "src/[!a]*.ts",
      "src/?.ts",
      "**/*.[jt]s",
      "lib/{a,b/c}/*.ts",
      "lib/b/**/*.ts",
      "src/@(api|b).ts",
      "src/!(api).ts",
      "src\\api.ts",
      "**/*.TS",
      "*.md",
      "**/.github/**/*.yml",
    ];
    for (const pattern of patterns) {
      const expected = listed.filter((file) => path.matchesGlob(file, pattern)).sort();
      expect({ pattern, matches: exploreGlob(root, pattern).matches }).toEqual({
        pattern,
        matches: expected,
      });
    }
  });

  it("refuses a literal prefix or searchPath that escapes, without the host path", () => {
    const root = makeFixture();
    fs.symlinkSync("/etc", path.join(root, "etc-link"));
    expect(() => exploreGlob(root, "etc-link/*")).toThrow(/^Path escapes explore root: etc-link$/);
    expect(() => exploreGlob(root, "*", "etc-link")).toThrow(
      /^Path escapes explore root: etc-link$/,
    );
  });

  it("never lists git metadata: a worktree's .git file, or a .git directory", () => {
    const root = makeFixture();
    addGitMetadata(root);
    expect(exploreGlob(root, ".git")).toEqual({ matches: [], truncated: false });
    expect(exploreGlob(root, "**/.git")).toEqual({ matches: [], truncated: false });
    expect(exploreGlob(root, ".*").matches).toEqual([".env.example"]);
    expect(exploreGlob(root, "sub/.git/*")).toEqual({ matches: [], truncated: false });
    expect(exploreGlob(root, "*", "sub/.git")).toEqual({ matches: [], truncated: false });
    expect(exploreGlob(root, "**/*", "sub").matches).toEqual(["sub/kept.txt"]);
  });
});

/** A linked worktree's root `.git` FILE, and a nested `.git` directory. */
function addGitMetadata(root: string): void {
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /data/repos/abc.git/worktrees/greet\n");
  fs.writeFileSync(path.join(root, ".env.example"), "greet=1\n");
  fs.mkdirSync(path.join(root, "sub", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "sub", ".git", "config"), "[core] greet\n");
  fs.writeFileSync(path.join(root, "sub", "kept.txt"), "kept\n");
}

describe("exploreGlobAsync", { timeout: 30_000 }, () => {
  it("returns exactly what exploreGlob does", async () => {
    const root = makeFixture();
    addGitMetadata(root);
    fs.mkdirSync(path.join(root, "src", "nested"));
    fs.writeFileSync(path.join(root, "src", "nested", "deep.ts"), "");
    for (const pattern of ["**/*.ts", "src/*.ts", "**/*", ".*", "missing/**/*", "sub/.git/*"]) {
      expect(await exploreGlobAsync(root, pattern)).toEqual(exploreGlob(root, pattern));
    }
    expect(await exploreGlobAsync(root, "*.ts", "src")).toEqual(exploreGlob(root, "*.ts", "src"));
    await expect(exploreGlobAsync(root, "../**/*")).rejects.toThrow(/relative to the explore root/);
  });

  it("stops between directories once aborted and reports what it has as truncated", async () => {
    const root = makeFixture();
    const controller = new AbortController();
    controller.abort();
    expect(await exploreGlobAsync(root, "**/*.ts", ".", { signal: controller.signal })).toEqual({
      matches: [],
      truncated: true,
    });
    // Aborted mid-walk: the root and `examples/` are read, `src/` is not.
    let checks = 0;
    const midWalk = {
      get aborted() {
        checks += 1;
        return checks > 2;
      },
    } as AbortSignal;
    expect(await exploreGlobAsync(root, "**/*.ts", ".", { signal: midWalk })).toEqual({
      matches: ["examples/basic.ts"],
      truncated: true,
    });
    // Still confined and validated first, like grep.
    await expect(
      exploreGlobAsync(root, "/etc/*", ".", { signal: controller.signal }),
    ).rejects.toThrow(/relative to the explore root/);
  });
});

// Each grep starts a worker thread; under a loaded uncached `turbo run test`
// thread start-up alone can take seconds, past vitest's 5 s default.
describe("exploreGrepJs", { timeout: 30_000 }, () => {
  it("returns file:line matches for an API symbol", async () => {
    const root = makeFixture();
    const result = await exploreGrepJs(root, "function greet");
    expect(result.matches).toEqual([
      { path: "src/api.ts", line: 1, text: "export function greet(name: string) {" },
    ]);
  });

  it("rejects invalid regex", async () => {
    const root = makeFixture();
    await expect(exploreGrepJs(root, "(")).rejects.toThrow(/Invalid grep pattern/);
  });

  it("walks in name-sorted depth-first order and caps matches", async () => {
    const root = makeFixture();
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "a", "b.txt"), "greet\n");
    fs.writeFileSync(path.join(root, "a-b.txt"), "greet\n");
    fs.writeFileSync(path.join(root, "a.txt"), "greet\n");
    const all = await exploreGrepJs(root, "greet");
    expect(all.matches.map((match) => match.path)).toEqual([
      "a/b.txt",
      "a-b.txt",
      "a.txt",
      "examples/basic.ts",
      "examples/basic.ts",
      "src/api.ts",
    ]);
    const capped = await exploreGrepJs(root, "greet", { maxMatches: 2 });
    expect(capped.matches.map((match) => match.path)).toEqual(["a/b.txt", "a-b.txt"]);
    expect(capped.truncated).toBe(true);
  });

  it("searches a single file passed as the path", async () => {
    const root = makeFixture();
    const result = await exploreGrepJs(root, "greet", { searchPath: "src/api.ts" });
    expect(result.matches).toEqual([
      { path: "src/api.ts", line: 1, text: "export function greet(name: string) {" },
    ]);
  });

  it("never follows symbolic links, skips binary files and clips long lines", async () => {
    const root = makeFixture();
    fs.symlinkSync(path.join(root, "src", "api.ts"), path.join(root, "linked.ts"));
    fs.writeFileSync(path.join(root, "blob.dat"), "greet\u0000binary\n");
    fs.writeFileSync(path.join(root, "image.png"), "greet\n");
    fs.writeFileSync(path.join(root, "long.txt"), `greet${"x".repeat(1_000)}\n`);
    const result = await exploreGrepJs(root, "greet", { searchPath: "." });
    const paths = result.matches.map((match) => match.path);
    expect(paths).not.toContain("linked.ts");
    expect(paths).not.toContain("blob.dat");
    expect(paths).not.toContain("image.png");
    const long = result.matches.find((match) => match.path === "long.txt");
    expect(long?.text.length).toBe(401);
    expect(long?.text.endsWith("…")).toBe(true);
  });

  it("stops a catastrophically backtracking pattern within its time budget", async () => {
    const root = makeFixture();
    // ~2^40 backtracking steps on the main thread would block for hours.
    fs.writeFileSync(path.join(root, "redos.txt"), `${"a".repeat(40)}!\n`);
    let ticks = 0;
    const counter = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    try {
      await expect(
        exploreGrepJs(root, "(a+)+(?=b)", { searchPath: "redos.txt", timeoutMs: 500 }),
      ).rejects.toThrow(/timed out/);
    } finally {
      clearInterval(counter);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // The main thread kept running timers while the regex spun in the worker.
    expect(ticks).toBeGreaterThan(5);
  });

  it("keeps matches found before the budget ran out", async () => {
    const root = makeFixture();
    fs.writeFileSync(path.join(root, "a-first.txt"), "aaab\n");
    fs.writeFileSync(path.join(root, "z-redos.txt"), `${"a".repeat(40)}!\n`);
    // The budget runs from the call, not from worker start-up, so it must
    // leave a loaded host time to start the worker and match the first file.
    const result = await exploreGrepJs(root, "(a+)+(?=b)", { timeoutMs: 5_000 });
    expect(result.matches.map((match) => match.path)).toEqual(["a-first.txt"]);
    expect(result.truncated).toBe(true);
  });

  it("never searches git metadata: a worktree's .git file, or a .git directory", async () => {
    const root = makeFixture();
    addGitMetadata(root);
    const result = await exploreGrepJs(root, "greet");
    expect(result.matches.map((match) => match.path)).toEqual([
      ".env.example",
      "examples/basic.ts",
      "examples/basic.ts",
      "src/api.ts",
    ]);
    for (const searchPath of [".git", "sub/.git", "sub/.git/config"]) {
      expect(await exploreGrepJs(root, "greet", { searchPath })).toEqual({
        matches: [],
        truncated: false,
      });
    }
  });

  it("returns at once when the call is aborted", async () => {
    const root = makeFixture();
    fs.writeFileSync(path.join(root, "redos.txt"), `${"a".repeat(40)}!\n`);
    const controller = new AbortController();
    const running = exploreGrepJs(root, "(a+)+(?=b)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(running).resolves.toEqual({ matches: [], truncated: true });
  });
});

describe("exploreRead", () => {
  it("returns numbered lines with paging metadata", () => {
    const root = makeFixture();
    const result = exploreRead(root, "src/api.ts", { offset: 1, limit: 2 });
    expect(result.path).toBe("src/api.ts");
    // Trailing newline from the fixture yields an empty final line.
    expect(result.totalLines).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(3);
    expect(result.content).toContain("1|export function greet");
    expect(result.content).toContain("2|  return");
  });

  it("clips one very long line and pages whole lines under the content budget", () => {
    const root = makeFixture();
    const lines = [`${"m".repeat(10_000)}`, ...Array.from({ length: 300 }, () => "y".repeat(100))];
    fs.writeFileSync(path.join(root, "bundle.js"), lines.join("\n"));
    const result = exploreRead(root, "bundle.js", { limit: 400 });
    const returned = result.content.split("\n");
    expect(returned[0]).toContain("[line clipped at 2000 chars]");
    expect(result.content.length).toBeLessThanOrEqual(24_000);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(returned.length + 1);
    // Every returned line is whole.
    expect(returned.slice(1).every((line) => line.endsWith("y".repeat(100)))).toBe(true);
  });

  it("refuses paths outside the root", () => {
    const root = makeFixture();
    expect(() => exploreRead(root, "../../etc/passwd")).toThrow(/escapes explore root/);
  });

  it("reports git metadata as not found, an in-root link to it included", () => {
    const root = makeFixture();
    addGitMetadata(root);
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "gitlink"));
    for (const requested of [".git", "./.git", "sub/.git/config", "gitlink", "sub/.git/missing"]) {
      expect(() => exploreRead(root, requested)).toThrow(
        expect.objectContaining({ code: "ENOENT", message: `Not found: ${requested}` }),
      );
    }
    expect(exploreRead(root, ".env.example").content).toBe("1|greet=1\n2|");
  });
});
