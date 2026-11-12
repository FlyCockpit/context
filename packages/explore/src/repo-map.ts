import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { SKIP_DIR_NAMES } from "./paths";

export type RepoMap = {
  generatedAt: string;
  rootName: string;
  languages: string[];
  manifests: string[];
  entrypoints: string[];
  examplePaths: string[];
  docPaths: string[];
  topLevel: string[];
  notablePackages: string[];
  hints: string[];
};

const ENTRY_CANDIDATES = [
  "README.md",
  "readme.md",
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/lib.rs",
  "src/main.rs",
  "lib/index.ts",
  "packages",
  "crates",
  "examples",
  "docs",
  "doc",
];

/**
 * Deterministic, cheap repo map — no LLM.
 *
 * Intended to be injected into the system prompt so the answer agent starts
 * oriented (layout, examples, entrypoints, languages) without spending tool
 * rounds on discovery.
 *
 * Asynchronous so a huge tree never blocks the shared event loop. Symlinks are
 * never followed: a checkout is untrusted, and a planted link (`packages ->
 * /data/checkouts`) must not put host directory names into the stored map.
 */
export async function generateRepoMap(root: string): Promise<RepoMap> {
  const rootReal = await fsp.realpath(path.resolve(root));
  const rootName = path.basename(rootReal);
  const topLevel = (await listDirNames(rootReal)).slice(0, 40);
  const manifests: string[] = [];
  const examplePaths: string[] = [];
  const docPaths: string[] = [];
  const entrypoints: string[] = [];
  const notablePackages: string[] = [];
  const languageVotes = new Map<string, number>();

  await walkLimited(rootReal, rootReal, 0, 4, (_absolute, relative, dirent) => {
    if (dirent.isDirectory()) {
      const base = dirent.name.toLowerCase();
      if (base === "examples" || base === "example" || base === "samples") {
        examplePaths.push(relative === "" ? dirent.name : `${relative}/${dirent.name}`);
      }
      if (base === "docs" || base === "doc" || base === "documentation") {
        docPaths.push(relative === "" ? dirent.name : `${relative}/${dirent.name}`);
      }
      return;
    }

    const name = dirent.name;
    const relFile = relative === "" ? name : `${relative}/${name}`;
    if (
      name === "package.json" ||
      name === "Cargo.toml" ||
      name === "go.mod" ||
      name === "pyproject.toml" ||
      name === "CMakeLists.txt" ||
      name.endsWith(".csproj")
    ) {
      if (manifests.length < 40) manifests.push(relFile);
    }

    voteLanguage(languageVotes, name);

    if (ENTRY_CANDIDATES.includes(relFile) || ENTRY_CANDIDATES.includes(name)) {
      if (entrypoints.length < 25) entrypoints.push(relFile);
    }
  });

  for (const workspace of ["packages", "crates", "apps"]) {
    if ((await plainEntryKind(rootReal, workspace)) !== "directory") continue;
    const dir = path.join(rootReal, workspace);
    for (const name of (await listDirNames(dir)).slice(0, 25)) {
      notablePackages.push(`${workspace}/${name}`);
    }
  }

  for (const candidate of ENTRY_CANDIDATES) {
    if ((await plainEntryKind(rootReal, candidate)) && !entrypoints.includes(candidate)) {
      entrypoints.unshift(candidate);
    }
  }

  const languages = [...languageVotes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang]) => lang);

  const hints: string[] = [];
  if (examplePaths.length > 0) {
    hints.push("Prefer exploring examplePaths before deep src/ dives for usage questions.");
  }
  if (notablePackages.length > 0) {
    hints.push(
      "This is a monorepo — identify the relevant package/crate before grepping the whole tree.",
    );
  }
  if (languages.includes("rust")) {
    hints.push("Rust: start with README, examples/, and src/lib.rs / crate roots.");
  }
  if (languages.includes("typescript") || languages.includes("javascript")) {
    hints.push("TS/JS: start with package.json exports, examples/, and packages/*/src/index.ts.");
  }

  return {
    generatedAt: new Date().toISOString(),
    rootName,
    languages,
    manifests: unique(manifests).slice(0, 40),
    entrypoints: unique(entrypoints).slice(0, 25),
    examplePaths: unique(examplePaths).slice(0, 20),
    docPaths: unique(docPaths).slice(0, 15),
    topLevel,
    notablePackages: unique(notablePackages).slice(0, 40),
    hints,
  };
}

/** Compact JSON for system-prompt injection (bounded). */
export function formatRepoMapForPrompt(map: RepoMap, maxChars = 6000): string {
  const body = JSON.stringify(map, null, 2);
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n…[truncated]`;
}

/**
 * Real (non-symlink) subdirectory names of `dir`. Dirent types come from
 * `lstat`, so a symlinked directory is not listed; the caller makes sure `dir`
 * itself is not reached through a symlink.
 */
async function listDirNames(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !SKIP_DIR_NAMES.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * `relative` (a `/`-separated path under `rootReal`) as a regular file or
 * directory reached without following any symlink, or `null`. Every component
 * is checked in turn with `lstat`, so neither the entry nor a parent of it may
 * be a link out of the checkout.
 */
async function plainEntryKind(
  rootReal: string,
  relative: string,
): Promise<"file" | "directory" | null> {
  let current = rootReal;
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = await fsp.lstat(current);
    } catch {
      return null;
    }
    const last = index === segments.length - 1;
    if (stats.isDirectory()) {
      if (last) return "directory";
      continue;
    }
    return last && stats.isFile() ? "file" : null;
  }
  return null;
}

/**
 * Depth-first, in `readdir` order (the order the synchronous walk had).
 * Directory dirents are `lstat`-typed, so a symlinked directory is visited as
 * a non-directory entry and never descended into.
 */
async function walkLimited(
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  visit: (absolute: string, relative: string, dirent: fs.Dirent) => void,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  const relative = path.relative(root, current).split(path.sep).join("/");
  for (const dirent of entries) {
    if (dirent.name.startsWith(".")) continue;
    if (dirent.isDirectory() && SKIP_DIR_NAMES.has(dirent.name)) continue;
    const absolute = path.join(current, dirent.name);
    visit(absolute, relative, dirent);
    if (dirent.isDirectory()) {
      await walkLimited(root, absolute, depth + 1, maxDepth, visit);
    }
  }
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".md": "markdown",
};

function voteLanguage(votes: Map<string, number>, filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  const lang = LANGUAGE_BY_EXTENSION[ext];
  if (!lang) return;
  votes.set(lang, (votes.get(lang) ?? 0) + 1);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
