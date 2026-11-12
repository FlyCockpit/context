#!/usr/bin/env node
// Install the pnpm pinned by package.json `packageManager` into a Docker image.
//
// Node 25+ no longer bundles corepack, and `npm install -g pnpm@<x>` trusts
// whatever the registry serves with no pinned checksum. This script instead:
//
//   1. reads `pnpm@<version>+sha512.<hex>` from package.json `packageManager`;
//   2. downloads exactly that registry tarball and refuses it unless its SHA-512
//      matches the pinned digest (the same digest Corepack checks locally);
//   3. unpacks it under <prefix>/lib/pnpm;
//   4. runs the package's own Corepack entry (`bin/pnpm.mjs`) once. pnpm 12+ is a
//      native binary: that entry downloads the `@pnpm/exe.<platform>` binary and
//      verifies its checksum against the npm registry signature (keys bundled in
//      the verified tarball) before writing it next to the wrapper;
//   5. links `pnpm` in <bin-dir> to that native binary and checks the version.
//
// pnpm 12 tarball layout (verified on 12.17.0): bin/pnpm.mjs + bin/pnpx.mjs
// (Corepack entries), a `pnpm` sh placeholder, native-binary.mjs, and dist/
// (bundled node-gyp + the get-pnpm downloader). There is no bin/pnpm.cjs.
//
// Usage: node install-pnpm.mjs <package.json> [bin-dir=/usr/local/bin] [prefix=/usr/local]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [manifestPath, binDir = "/usr/local/bin", prefix = "/usr/local"] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: install-pnpm.mjs <package.json> [bin-dir] [prefix]");
  process.exit(2);
}

function fail(message) {
  console.error(`install-pnpm: ${message}`);
  process.exit(1);
}

const { packageManager } = JSON.parse(readFileSync(manifestPath, "utf8"));
const match = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(packageManager ?? "");
if (!match) {
  fail(`packageManager must be pnpm@<x.y.z>+sha512.<hex>, got ${packageManager}`);
}
const [, version, expected] = match;

const url = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  fail(`${url} returned HTTP ${response.status}`);
}
const tarball = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha512").update(tarball).digest("hex");
if (actual !== expected) {
  fail(`SHA-512 mismatch for pnpm ${version}; refusing to install`);
}

const target = join(prefix, "lib", "pnpm");
const work = mkdtempSync(join(tmpdir(), "pnpm-"));
try {
  const archive = join(work, "pnpm.tgz");
  writeFileSync(archive, tarball);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1", "--no-same-owner"], {
    stdio: "inherit",
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

const wrapper = join(target, "bin", "pnpm.mjs");
if (!existsSync(wrapper)) {
  fail(`pnpm ${version} has no bin/pnpm.mjs; the tarball layout changed — update this script`);
}

// Fetch the native binary through the verified wrapper. Run from the package
// directory so no project .npmrc is consulted, and drop the Corepack variables
// that could point it at another registry or waive the signature check.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("COREPACK_")) delete env[name];
}
const reported = execFileSync(process.execPath, [wrapper, "--version"], {
  cwd: target,
  env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
if (reported !== version) {
  fail(`expected pnpm ${version}, the wrapper reported ${reported}`);
}

const native = join(target, "pnpm-native");
if (!lstatSync(native, { throwIfNoEntry: false })?.isFile()) {
  fail(`the native binary was not placed at ${native}`);
}

mkdirSync(binDir, { recursive: true });
const link = join(binDir, "pnpm");
rmSync(link, { force: true });
symlinkSync(native, link);

const linked = execFileSync(link, ["--version"], { encoding: "utf8" }).trim();
if (linked !== version) {
  fail(`${link} reports ${linked}, expected ${version}`);
}
console.log(`install-pnpm: pnpm ${version} installed (tarball sha512 + binary signature verified)`);
