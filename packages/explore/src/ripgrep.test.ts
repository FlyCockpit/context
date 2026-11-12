import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exploreGrepJs } from "./fs-ops";
import { GrepTimeoutError } from "./grep-worker";
import { exploreGrep, findRipgrepOnPath, parseRipgrepMatch, ripgrepArgs } from "./ripgrep";

const SAMPLE_PKG = path.resolve(import.meta.dirname, "../fixtures/sample-pkg");
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * A stand-in `rg`: records its cwd and argv, runs `preamble` (shell), prints
 * `stdout`, exits `code`.
 */
function fakeRipgrep(stdout: string, code = 0, preamble = ""): { binary: string; logFile: string } {
  const dir = tempDir("cockpit-context-fake-rg-");
  const logFile = path.join(dir, "invocation.log");
  const payload = path.join(dir, "stdout.jsonl");
  fs.writeFileSync(payload, stdout);
  const binary = path.join(dir, "rg");
  fs.writeFileSync(
    binary,
    `#!/bin/sh\npwd > '${logFile}'\nprintf '%s\\n' "$@" >> '${logFile}'\n${preamble}\ncat '${payload}'\nexit ${code}\n`,
  );
  fs.chmodSync(binary, 0o755);
  return { binary, logFile };
}

const matchEvent = (file: string, line: number, text: string) =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: file },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [],
    },
  });

function makeTree(): string {
  const root = tempDir("cockpit-context-rg-parity-");
  const write = (relative: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), body);
  };
  write("src/greet.ts", "export function greet() {}\nexport const greeting = 1;\r\n");
  write("a/b.txt", "greet a/b\n");
  write("a-b.txt", "greet a-b\n");
  write("a.txt", "Greet upper\ngreet lower\n");
  write(".github/workflows/ci.yml", "run: greet\n");
  write("node_modules/dep/index.js", "greet\n");
  write("packages/x/dist/out.js", "greet\n");
  write("build", "greet (a file named like a skipped directory)\n");
  write("logo.PNG", "greet\n");
  write("long.txt", `greet${"z".repeat(800)}\n`);
  // A linked worktree's `.git` is a FILE naming a host path; a nested one is a directory.
  write(".git", "gitdir: /data/repos/greet.git/worktrees/abc\n");
  write("a/.git/config", "[remote] greet\n");
  write("big.txt", `greet\n${"q".repeat(600_000)}\n`);
  fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "link.txt"));
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ripgrepArgs", () => {
  it("passes the pattern as --regexp and the target after --", () => {
    const args = ripgrepArgs("-rf", "src", { maxMatches: 7, caseInsensitive: true });
    expect(args.slice(-4)).toEqual(["--regexp", "-rf", "--", "src"]);
    expect(args).toContain("--json");
    expect(args).toContain("--no-config");
    expect(args).toContain("--ignore-case");
    expect(args.join(" ")).toContain("--max-count 7");
    expect(args.join(" ")).toContain("--max-filesize 512000");
    expect(args.join(" ")).toContain("--sort path");
    expect(args.join(" ")).toContain("--glob !node_modules/");
    expect(args.join(" ")).toContain("--iglob !*.png");
    expect(args).not.toContain("--follow");
  });

  it("excludes .git as a file too, not only as a directory", () => {
    const joined = ripgrepArgs("x", ".", { maxMatches: 1 }).join(" ");
    expect(joined).toContain("--glob !.git/");
    expect(joined).toMatch(/--glob !\.git( |$)/);
  });
});

describe("parseRipgrepMatch", () => {
  it("parses text and base64 bytes, and ignores other events", () => {
    expect(parseRipgrepMatch(matchEvent("./src/a.ts", 3, "hit"))).toEqual({
      rawPath: "./src/a.ts",
      line: 3,
      text: "hit",
    });
    const bytes = JSON.stringify({
      type: "match",
      data: {
        path: { bytes: Buffer.from("src/b.ts").toString("base64") },
        lines: { bytes: Buffer.from("café\r\n").toString("base64") },
        line_number: 1,
      },
    });
    expect(parseRipgrepMatch(bytes)).toEqual({ rawPath: "src/b.ts", line: 1, text: "café" });
    expect(parseRipgrepMatch(JSON.stringify({ type: "begin", data: {} }))).toBeNull();
    expect(parseRipgrepMatch("not json")).toBeNull();
  });
});

describe("exploreGrep", () => {
  it("runs ripgrep from the real root with a root-relative target", async () => {
    const { binary, logFile } = fakeRipgrep(
      [
        matchEvent(
          "./src/greet.ts",
          2,
          "export function greet(name: string, shout = false): string {",
        ),
      ].join("\n"),
    );
    const result = await exploreGrep(SAMPLE_PKG, "greet", { ripgrep: binary });
    expect(result).toEqual({
      matches: [
        {
          path: "src/greet.ts",
          line: 2,
          text: "export function greet(name: string, shout = false): string {",
        },
      ],
      truncated: false,
    });
    const [cwd, ...argv] = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(cwd).toBe(fs.realpathSync.native(SAMPLE_PKG));
    expect(argv.slice(-2)).toEqual(["--", "."]);
  });

  it("stops at maxMatches and reports truncation", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => matchEvent(`f${index}.ts`, 1, "hit"));
    const { binary } = fakeRipgrep(lines.join("\n"));
    const result = await exploreGrep(SAMPLE_PKG, "hit", { ripgrep: binary, maxMatches: 3 });
    expect(result.matches.map((match) => match.path)).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
    expect(result.truncated).toBe(true);
  });

  it("falls back to the JavaScript walk when ripgrep errors with no output", async () => {
    const { binary } = fakeRipgrep("", 2);
    const result = await exploreGrep(SAMPLE_PKG, "greet\\(", { ripgrep: binary });
    expect(result).toEqual(await exploreGrepJs(SAMPLE_PKG, "greet\\("));
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("falls back when the binary cannot be spawned", async () => {
    const result = await exploreGrep(SAMPLE_PKG, "shout", {
      ripgrep: path.join(os.tmpdir(), "cockpit-context-no-such-rg-binary"),
    });
    expect(result).toEqual(await exploreGrepJs(SAMPLE_PKG, "shout"));
  });

  it("rejects an invalid JavaScript pattern before choosing a backend", async () => {
    const { binary, logFile } = fakeRipgrep("");
    await expect(exploreGrep(SAMPLE_PKG, "(", { ripgrep: binary })).rejects.toThrow(
      /Invalid grep pattern/,
    );
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("never runs ripgrep on a path inside git metadata", async () => {
    const root = tempDir("cockpit-context-rg-git-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /data/repos/abc.git/worktrees/greet\n");
    const { binary, logFile } = fakeRipgrep(matchEvent(".git", 1, "gitdir: /data/repos"));
    expect(await exploreGrep(root, "gitdir", { ripgrep: binary, searchPath: ".git" })).toEqual({
      matches: [],
      truncated: false,
    });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("uses the JavaScript walk when ripgrep is disabled", async () => {
    const result = await exploreGrep(SAMPLE_PKG, "shout", { ripgrep: false });
    expect(result).toEqual(await exploreGrepJs(SAMPLE_PKG, "shout"));
  });
});

// Parity against a real ripgrep. It runs wherever `rg` is on PATH — the
// production image installs it — and is skipped elsewhere; the fake-binary
// tests above cover the spawn/parse path everywhere.
const realRipgrep = findRipgrepOnPath();

describe.skipIf(realRipgrep === null)("ripgrep / JavaScript parity", () => {
  const cases: Array<[string, string, Parameters<typeof exploreGrepJs>[2]]> = [
    ["sample-pkg: function", "greet", {}],
    ["sample-pkg: example usage", "greet\\(", { searchPath: "examples" }],
    ["sample-pkg: single file", "shout", { searchPath: "src/greet.ts" }],
    ["sample-pkg: no match", "definitely-not-present", {}],
  ];

  for (const [name, pattern, options] of cases) {
    it(name, async () => {
      const rg = await exploreGrep(SAMPLE_PKG, pattern, {
        ...options,
        ripgrep: realRipgrep ?? false,
      });
      expect(rg).toEqual(await exploreGrepJs(SAMPLE_PKG, pattern, options));
    });
  }

  it("agrees on skip dirs, binary extensions, size cap, symlinks, CRLF, clipping and order", async () => {
    const root = makeTree();
    for (const options of [{}, { caseInsensitive: true }, { maxMatches: 3 }, { searchPath: "a" }]) {
      const rg = await exploreGrep(root, "greet", { ...options, ripgrep: realRipgrep ?? false });
      expect(rg).toEqual(await exploreGrepJs(root, "greet", options));
      expect(rg.matches.filter((match) => match.path.split("/").includes(".git"))).toEqual([]);
    }
  });

  it("falls back to JavaScript for a pattern Rust regex rejects", async () => {
    const root = makeTree();
    const rg = await exploreGrep(root, "greet(?= lower)", { ripgrep: realRipgrep ?? false });
    expect(rg.matches.map((match) => match.path)).toEqual(["a.txt"]);
    expect(rg).toEqual(await exploreGrepJs(root, "greet(?= lower)"));
  });

  it("keeps a catastrophic Rust-rejected pattern within the time budget", async () => {
    const root = tempDir("cockpit-context-rg-redos-");
    fs.writeFileSync(path.join(root, "redos.txt"), `${"a".repeat(40)}!\n`);
    const started = Date.now();
    await expect(
      exploreGrep(root, "(a+)+(?=b)", { ripgrep: realRipgrep ?? false, timeoutMs: 500 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("exploreGrep time budget", () => {
  it("reports a ripgrep timeout with no matches as GrepTimeoutError, like the JS backend", async () => {
    const root = tempDir("cockpit-context-rg-timeout-");
    // `exec` so the SIGKILL reaches the sleeping process itself.
    const { binary } = fakeRipgrep("", 0, "exec sleep 5");
    const started = Date.now();
    const error = await exploreGrep(root, "greet", { ripgrep: binary, timeoutMs: 200 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrepTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("keeps ripgrep's partial matches when it times out after some", async () => {
    const root = tempDir("cockpit-context-rg-timeout-partial-");
    const { binary } = fakeRipgrep(
      "",
      0,
      `printf '%s\\n' '${matchEvent("a.txt", 1, "greet")}'\nexec sleep 5`,
    );
    const result = await exploreGrep(root, "greet", { ripgrep: binary, timeoutMs: 300 });
    expect(result).toEqual({
      matches: [{ path: "a.txt", line: 1, text: "greet" }],
      truncated: true,
    });
  });

  it("gives the JavaScript fallback only the budget ripgrep left", async () => {
    const root = tempDir("cockpit-context-rg-remaining-");
    fs.writeFileSync(path.join(root, "redos.txt"), `${"a".repeat(40)}!\n`);
    // ripgrep spends most of the budget, then rejects the pattern (exit 2).
    const { binary } = fakeRipgrep("", 2, "sleep 1");
    const started = Date.now();
    await expect(
      exploreGrep(root, "(a+)+(?=b)", { ripgrep: binary, timeoutMs: 1_200 }),
    ).rejects.toBeInstanceOf(GrepTimeoutError);
    // A fresh budget for the fallback would take at least 2.2 s.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
