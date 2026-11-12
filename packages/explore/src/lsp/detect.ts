import fs from "node:fs";
import path from "node:path";

import { resolveWithinRoot, SKIP_DIR_NAMES } from "../paths";
import { LANGUAGE_SERVER_SPECS, type LanguageServerSpec, type LspLanguage } from "./specs";

/** Directory entries one detection walk may visit. */
const MAX_DETECT_VISITS = 20_000;
/** How deep the walk goes below the start directory. */
const MAX_DETECT_DEPTH = 8;

/** Languages present under a directory, each with one sample file (root-relative). */
export type DetectedLanguages = Map<LspLanguage, string>;

/**
 * Which LSP languages a checkout has files of, breadth-first from `start`
 * (root-relative, default the root), so each sample is a shallow file — the
 * workspace-symbol tool opens it to make the server load the project.
 *
 * Skips `SKIP_DIR_NAMES`, dot directories and symlinks, and stops after
 * `MAX_DETECT_VISITS` entries or once every language has been seen.
 */
export function detectLspLanguages(
  root: string,
  options: {
    start?: string;
    specs?: Readonly<Record<LspLanguage, LanguageServerSpec>>;
  } = {},
): DetectedLanguages {
  const specs = options.specs ?? LANGUAGE_SERVER_SPECS;
  const rootReal = resolveWithinRoot(root, ".");
  const startReal = resolveWithinRoot(root, options.start ?? ".");
  const byExtension = new Map<string, LspLanguage>();
  for (const spec of Object.values(specs)) {
    for (const ext of Object.keys(spec.languageIds)) byExtension.set(ext, spec.language);
  }
  const wanted = new Set(Object.values(specs).map((spec) => spec.language));
  const found: DetectedLanguages = new Map();

  let visits = 0;
  let level: string[] = [startReal];
  for (let depth = 0; depth <= MAX_DETECT_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        visits += 1;
        if (visits > MAX_DETECT_VISITS) return found;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !SKIP_DIR_NAMES.has(entry.name)) {
            next.push(path.join(dir, entry.name));
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const language = byExtension.get(path.extname(entry.name).toLowerCase());
        if (!language || found.has(language)) continue;
        found.set(
          language,
          path.relative(rootReal, path.join(dir, entry.name)).split(path.sep).join("/"),
        );
        if (found.size === wanted.size) return found;
      }
    }
    level = next;
  }
  return found;
}

/**
 * The server's workspace root, root-relative: the package subdirectory when it
 * holds one of the language's project markers (its own `package.json` /
 * `pyproject.toml`, …), otherwise the checkout root (`"."`).
 */
export function lspWorkspaceDir(
  root: string,
  subdirectory: string | undefined,
  spec: LanguageServerSpec,
): string {
  const sub = subdirectory
    ?.trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!sub || sub === ".") return ".";
  let subReal: string;
  try {
    subReal = resolveWithinRoot(root, sub);
    if (!fs.statSync(subReal).isDirectory()) return ".";
  } catch {
    return ".";
  }
  const hasMarker = spec.projectMarkers.some((marker) => {
    try {
      return fs.statSync(path.join(subReal, marker)).isFile();
    } catch {
      return false;
    }
  });
  if (!hasMarker) return ".";
  return path.relative(resolveWithinRoot(root, "."), subReal).split(path.sep).join("/") || ".";
}
