#!/usr/bin/env node
// Compiles tools/landlock/cockpit-context-landlock.c, the language-server sandbox helper
// (packages/explore/src/lsp/sandbox.ts, docs/deploy.md § Language-server
// sandbox). One place for the compiler flags: the production image's
// `landlock-build` stage, `pnpm run lsp:build-sandbox`, the server's dev
// script and the integration tests all run this script.
//
//   node scripts/build-landlock-helper.mjs                # → tools/landlock/build/cockpit-context-landlock
//   node scripts/build-landlock-helper.mjs --out <file>   # somewhere else
//   node scripts/build-landlock-helper.mjs --if-possible  # dev: never fail
//   node scripts/build-landlock-helper.mjs --cc gcc       # compiler (default: $CC or cc)
//
// Rebuilds only when the output is missing or older than the source (or this
// script). With --if-possible, a missing compiler or a failed build prints a
// notice and exits 0: the app then reports the LSP tools as off (the helper is
// missing) instead of the dev server failing to start.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "tools/landlock/cockpit-context-landlock.c");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const ifPossible = args.includes("--if-possible");
const out = path.resolve(
  option("--out") ?? path.join(root, "tools/landlock/build/cockpit-context-landlock"),
);
const cc = option("--cc") ?? process.env.CC ?? "cc";

/** Hardened, warning-free build; libc only. */
const CFLAGS = [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fstack-protector-strong",
  "-D_FORTIFY_SOURCE=2",
  "-fPIE",
  "-pie",
  "-Wl,-z,relro",
  "-Wl,-z,now",
];

const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

function finish(message, failed) {
  if (failed && !ifPossible) {
    console.error(`build-landlock-helper: ${message}`);
    process.exit(1);
  }
  console.log(`build-landlock-helper: ${message}`);
  process.exit(0);
}

if (process.platform !== "linux") {
  finish("Landlock is Linux-only; skipped (the LSP tools stay off on this host).", true);
}

const built = mtime(out);
if (
  built !== undefined &&
  built >= (mtime(source) ?? 0) &&
  built >= (mtime(fileURLToPath(import.meta.url)) ?? 0)
) {
  finish(`${path.relative(root, out) || out} is up to date.`, false);
}

const probe = spawnSync(cc, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  finish(
    `no C compiler (${cc}); the Landlock helper was not built, so COCKPIT_CONTEXT_LSP_SANDBOX=required leaves the LSP tools off. Install gcc (or set CC) and run \`pnpm run lsp:build-sandbox\`.`,
    true,
  );
}

mkdirSync(path.dirname(out), { recursive: true });
const temp = `${out}.tmp-${process.pid}`;
const result = spawnSync(cc, [...CFLAGS, "-o", temp, source], { encoding: "utf8" });
if (result.status !== 0) {
  rmSync(temp, { force: true });
  finish(
    `compiling ${path.relative(root, source)} failed:\n${result.stdout}${result.stderr}`,
    true,
  );
}
renameSync(temp, out);
finish(`built ${path.relative(root, out) || out}.`, false);
