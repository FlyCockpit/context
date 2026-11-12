#!/usr/bin/env node
// Checks the production image's runtime tools. Run by the Dockerfile at build
// time (as the runtime user) and by hand in a live container:
//
//   docker compose exec app node scripts/check-runtime-tools.mjs
//
// It verifies that git (2.37 or later: the git layer pins resolved addresses
// with http.curloptResolve), ssh (OpenSSH 8.4 or later, with a working
// SSH_ASKPASS_REQUIRE=force round trip), ssh-keygen, ssh-keyscan and rg are
// on PATH, that the Landlock helper (the language-server sandbox,
// COCKPIT_CONTEXT_LSP_SANDBOX) is installed, and that both language servers resolve from the bundled server the way
// packages/explore/src/lsp/specs.ts resolves them (createRequire anchored at
// apps/server/dist/index.mjs): TypeScript 7's platform binary and pyright's
// langserver entry. Each server must answer `--version`. No network, no
// checkout, no env read beyond PATH. Exits 1 if any piece is missing.
//
// Whether the kernel enforces Landlock depends on the host (Linux 5.13+ with
// landlock in the LSM list), not on the image, so by default a failed
// restriction is reported, not required. In a running container,
// `--require-sandbox` makes it a failure too:
//
//   docker compose exec app node scripts/check-runtime-tools.mjs --require-sandbox
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const requireSandbox = flags.includes("--require-sandbox");
const anchor = positional[0] ?? path.join(root, "apps/server/dist/index.mjs");
const failures = [];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: true, status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`ok   ${label}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("git", () => {
  const { ok, output } = run("git", ["--version"]);
  if (!ok) throw new Error(output);
  const match = /git version (\d+)\.(\d+)/.exec(output);
  if (!match) throw new Error(`unrecognized version: ${output}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 2 || (major === 2 && minor < 37)) throw new Error(`${output} is older than 2.37`);
  return output;
});
check("ssh", () => {
  const { ok, output } = run("ssh", ["-V"]);
  if (!ok) throw new Error(output);
  // SSH key imports hand the passphrase to ssh-keygen through SSH_ASKPASS with
  // SSH_ASKPASS_REQUIRE=force, which OpenSSH honours (without DISPLAY) from 8.4.
  const match = /OpenSSH_(\d+)\.(\d+)/.exec(output);
  if (!match) throw new Error(`unrecognized version: ${output}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 8 || (major === 8 && minor < 4)) throw new Error(`${output} is older than 8.4`);
  return output;
});
for (const tool of ["ssh-keygen", "ssh-keyscan"]) {
  // Both print usage and exit non-zero on `-?`; only a spawn error means missing.
  check(tool, () => {
    const { ok, output } = run(tool, ["-?"]);
    if (!ok) throw new Error(output);
    return "";
  });
}
// The import path of packages/repos/src/ssh-tools.ts in miniature: decrypt a
// passphrase-protected key with the passphrase supplied only by an askpass
// helper (never argv), stdin closed, in a private temp dir removed afterwards.
// It runs in os.tmpdir(), not under COCKPIT_CONTEXT_DATA_DIR, so it says nothing about
// whether the data volume is mounted noexec (docs/deploy.md).
check("ssh-keygen askpass hand-off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-context-askpass-check-"));
  try {
    const key = path.join(dir, "key");
    const generated = run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "check",
      "-C",
      "",
      "-f",
      key,
    ]);
    if (!generated.ok || generated.status !== 0) throw new Error(generated.output);
    writeFileSync(path.join(dir, "passphrase"), "check", { mode: 0o600 });
    const helper = path.join(dir, "askpass");
    writeFileSync(helper, '#!/bin/sh\nexec cat -- "$(dirname -- "$0")/passphrase"\n', {
      mode: 0o700,
    });
    chmodSync(helper, 0o700);
    const result = spawnSync("ssh-keygen", ["-q", "-p", "-N", "", "-f", key], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        SSH_ASKPASS: helper,
        SSH_ASKPASS_REQUIRE: "force",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`.trim());
    const derived = run("ssh-keygen", ["-y", "-P", "", "-f", key]);
    if (!derived.ok || derived.status !== 0) throw new Error(derived.output);
    return "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("rg", () => {
  const { ok, status, output } = run("rg", ["--version"]);
  if (!ok || status !== 0) throw new Error(output);
  return output.split("\n")[0];
});

// The language-server sandbox (packages/explore/src/lsp/sandbox.ts): the
// Landlock helper at the image's fixed path (or, in a Cockpit Context checkout, the dev
// build of `pnpm run lsp:build-sandbox`), its --probe, and a real restriction:
// a sandboxed `cat` must read the one directory it is given and must not read
// /etc/passwd.
const helper = [
  "/usr/local/libexec/cockpit-context/cockpit-context-landlock",
  path.join(root, "tools/landlock/build/cockpit-context-landlock"),
].find((candidate) => existsSync(candidate));
check("cockpit-context-landlock (Landlock helper)", () => {
  if (!helper)
    throw new Error("not installed at /usr/local/libexec/cockpit-context/cockpit-context-landlock");
  const { ok, output } = run(helper, ["--probe"]);
  if (!ok) throw new Error(output);
  return path.relative(root, helper).startsWith("..") ? helper : path.relative(root, helper);
});
const landlockFailure = (() => {
  if (!helper) return "the helper is missing";
  const probe = run(helper, ["--probe"]);
  let parsed;
  try {
    parsed = JSON.parse(probe.output.split("\n")[0] ?? "");
  } catch {
    return `--probe printed no result (${probe.output.split("\n")[0]})`;
  }
  if (!parsed.landlock) return parsed.reason ?? "this kernel has no Landlock";
  if (!parsed.enforced) return parsed.reason ?? "the restriction was not enforced";
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-context-landlock-check-"));
  try {
    writeFileSync(path.join(dir, "inside"), "inside\n");
    const cat = existsSync("/usr/bin/cat") ? "/usr/bin/cat" : "/bin/cat";
    const inside = run(helper, ["--rx", "/usr", "--ro", dir, "--", cat, path.join(dir, "inside")]);
    if (inside.status !== 0)
      return `a sandboxed cat could not read its allowed directory (${inside.output})`;
    const outside = run(helper, ["--rx", "/usr", "--ro", dir, "--", cat, "/etc/passwd"]);
    if (outside.status === 0) return "a sandboxed cat read /etc/passwd";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const protections = [
    "filesystem",
    parsed.tcp ? "TCP denied" : "TCP not restricted (ABI < 4)",
    parsed.scoping ? "signal/abstract-socket scoping" : "no scoping (ABI < 6)",
  ];
  console.log(`ok   Landlock sandbox: ABI ${parsed.abi}, ${protections.join(", ")}`);
  return undefined;
})();
if (landlockFailure && requireSandbox) {
  check("Landlock sandbox", () => {
    throw new Error(landlockFailure);
  });
} else if (landlockFailure) {
  console.log(
    `info Landlock sandbox: ${landlockFailure}. The app probes again at runtime and leaves the LSP tools off ` +
      "if it still fails.",
  );
}

check(`language servers resolve from ${path.relative(root, anchor) || anchor}`, () => {
  if (!existsSync(anchor)) throw new Error(`${anchor} does not exist (build the server first)`);
  return "";
});
const localRequire = createRequire(anchor);
check("TypeScript 7 (tsc --lsp)", () => {
  const packageJson = localRequire.resolve("typescript/package.json");
  const platformPackage = createRequire(packageJson).resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const binary = path.join(path.dirname(platformPackage), "lib", "tsc");
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  return `${path.relative(root, binary)} (${version})`;
});
check("pyright (pyright-langserver)", () => {
  const langserver = localRequire.resolve("pyright/langserver.index.js");
  const cli = path.join(path.dirname(langserver), "index.js");
  const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
  return `${path.relative(root, langserver)} (${version})`;
});

// Root backup scripts and the migration runner resolve from different anchors.
check("migration/backup module closure", () => {
  const dbRequire = createRequire(path.join(root, "packages/db/package.json"));
  const rootRequire = createRequire(path.join(root, "package.json"));
  for (const name of ["pg", "prisma/config", "dotenv"]) dbRequire.resolve(name);
  rootRequire.resolve("@aws-sdk/client-s3");
  if (!existsSync(path.join(root, "packages/db/node_modules/prisma/build/index.js")))
    throw new Error("Prisma runtime CLI is missing");
  return "pg, Prisma CLI/config, dotenv and S3 SDK resolve";
});

if (failures.length > 0) {
  console.error(`\nRuntime tools check failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nRuntime tools check passed.");
