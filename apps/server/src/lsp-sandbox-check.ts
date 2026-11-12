/**
 * The language-server sandbox's hostile-checkout check, shipped in the
 * production image as `apps/server/dist/lsp-sandbox-check.mjs`:
 *
 *   docker compose exec app node apps/server/dist/lsp-sandbox-check.mjs
 *   docker compose exec app node apps/server/dist/lsp-sandbox-check.mjs --work-dir /data
 *   docker compose exec app node apps/server/dist/lsp-sandbox-check.mjs --control
 *
 * It writes a checkout whose tsconfig (`extends`, `files`, `include`,
 * `paths`), pyright config (`extraPaths`) and symlinks reach another checkout
 * holding a secret, starts the REAL language servers the way the app does
 * (COCKPIT_CONTEXT_LSP_SANDBOX=required: under the Landlock helper), calls every LSP
 * tool, and launches a probe process through the same sandbox that tries to
 * read the other checkout, the data dir, `/proc/1/environ`, this process's
 * `/proc/<pid>/environ`, the app's dist and `/etc/passwd`, and to open a TCP
 * connection (packages/explore/src/lsp/sandbox-check.ts). It fails when the
 * secret or the data-dir path appears in any output, when any of those
 * accesses works, or when the servers stop answering inside the checkout.
 * `--work-dir` puts the fixture there instead of the temp directory (use the
 * data volume to test the layout real checkouts have) and also probes that
 * directory itself: its listing, its real `checkouts/`, `repos/`, `tmp/` and
 * `ssh/` listings and one real checkout file and bare-clone file, where they
 * exist (the output names each one probed and each one absent). The fixture
 * is always removed. Reads no env, needs no database and no network.
 *
 * `--control` runs the same fixture and probes WITHOUT the sandbox
 * (COCKPIT_CONTEXT_LSP_SANDBOX=off) and passes only if they do leak there, so a passing
 * check cannot be vacuous.
 *
 * Exit codes: 0 sandboxed and nothing leaked (or, with --control, unsandboxed
 * and leaked); 1 a leak or a broken server (or a control that did not leak);
 * 2 the sandbox is unavailable here (the app then offers no LSP tools).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { runLspSandboxCheck } from "@cockpit-context/explore/sandbox-check";

function workDirArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--work-dir");
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
// The app's own code: this file and, next to it in dist/, the server bundle.
const appFiles = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./index.mjs", import.meta.url)),
].filter((file) => fs.existsSync(file));

if (argv.includes("--control")) {
  const control = await runLspSandboxCheck({
    sandbox: "off",
    workDir: workDirArg(argv),
    appFiles,
  });
  const leakedTools = [...new Set(control.calls.filter((call) => call.leaked).map((c) => c.tool))];
  const hostile = control.probes.filter((probe) => probe.mustDeny);
  for (const skipped of control.skipped) console.log(`n/a    ${skipped}: not probed`);
  for (const probe of hostile) {
    const state = probe.allowed ? "leaks" : probe.reachable ? "MISSED" : "n/a  ";
    console.log(
      `${state} ${probe.name}${probe.reachable ? "" : " (not readable by this process either)"}`,
    );
  }
  const missed = hostile.filter((probe) => probe.reachable && !probe.allowed);
  if (leakedTools.length === 0 || missed.length > 0) {
    console.error(
      "Control FAILED: unsandboxed, the hostile fixture did not leak everything it should.",
    );
    process.exit(1);
  }
  console.log(
    `Control ok: unsandboxed, the secret leaked through ${leakedTools.join(", ")}, and ${hostile.filter((probe) => probe.allowed).length} hostile accesses worked.`,
  );
  process.exit(0);
}

const result = await runLspSandboxCheck({
  sandbox: "required",
  workDir: workDirArg(argv),
  appFiles,
});

if (result.sandbox.mode !== "landlock" || !result.toolsOffered) {
  const detail =
    result.sandbox.mode === "unavailable" ? result.sandbox.detail : result.sandbox.mode;
  console.error(`UNAVAILABLE the language-server sandbox cannot run here: ${detail}`);
  console.error("The app offers no LSP tools in this state.");
  process.exit(2);
}

const { abi, tcp, scoping } = result.sandbox;
console.log(
  `Landlock ABI ${abi}: filesystem allowlist on, TCP ${tcp ? "denied" : "NOT restricted (needs ABI 4, Linux 6.7)"}, signal/abstract-socket scoping ${scoping ? "on" : "off (needs ABI 6, Linux 6.12)"}.\n`,
);
for (const probe of result.probes.filter((candidate) => candidate.mustDeny)) {
  console.log(`${probe.allowed ? "LEAK  " : "denied"} ${probe.name} (${probe.detail})`);
}
for (const skipped of result.skipped) console.log(`n/a    ${skipped}: not probed`);
if (!tcp)
  console.log(
    "info   TCP is not restricted at this Landlock ABI; the probe was allowed to connect.",
  );
const leaks = result.calls.filter((call) => call.leaked);
for (const call of leaks) {
  console.error(`LEAK ${call.tool} ${JSON.stringify(call.input)}\n${call.output}\n`);
}
for (const check of result.working) {
  console.log(`${check.ok ? "ok    " : "FAIL  "} ${check.name}`);
  if (!check.ok) console.error(check.output);
}
console.log(
  `\n${result.calls.length} LSP tool calls against the hostile checkout, ${leaks.length} leaked.`,
);

const broken = result.working.some((check) => !check.ok);
if (result.leaked || broken) {
  console.error("\nLSP sandbox check FAILED.");
  process.exit(1);
}
console.log(
  "\nLSP sandbox check passed: nothing outside the checkout reached a tool output or the server process.",
);
