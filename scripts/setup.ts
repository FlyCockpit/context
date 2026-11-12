/**
 * First-run onboarding script. Idempotent — safe to re-run.
 *
 * One command takes a fresh clone to a runnable state:
 *   1. Copy .env.example -> .env if .env does not exist.
 *   2. Copy apps/web/.env.example -> apps/web/.env if it does not exist.
 *   4. Generate BETTER_AUTH_SECRET if it is empty in .env, and mint a
 *      COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring if that is empty (never replaced once set).
 *   5. Ask for the developer's email and write it to ADMIN_EMAILS in .env, so
 *      their first local sign-up becomes the first admin.
 *   6. Point SMTP_* at the local mailpit sink (email verification is enforced
 *      on signup — without this, first login has no way to receive the
 *      verification link). A real provider configured in .env is left alone.
 *   7. Start the local Docker services — Postgres + mailpit
 *      (`pnpm dev:services`, the canonical root docker-compose.dev.yml).
 *   8. Wait for Postgres and the sink to accept connections.
 *   9. Apply the schema (`pnpm db:migrate:apply`).
 *  10. Check whether the global portless CLI is available for `pnpm dev`.
 *  11. Install the Claude Code safety hooks into .claude/settings.json (see
 *      AGENTS.md; harmless for other harnesses).
 *
 * After this, `pnpm dev` is the only remaining step.
 *
 * Run: `pnpm run setup` (the explicit `run` form — `setup` is also a pnpm
 * builtin, and on some pnpm versions the bare `pnpm setup` invokes the builtin
 * instead of this script)
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { installClaudeHooks } from "./install-claude-hooks.js";
import { looksLikeEmail, readAdminEmailsValue, withAdminEmail } from "./lib/admin-email-env.js";
import { readEncryptionKeyringValue, withEncryptionKeyring } from "./lib/encryption-keyring-env.js";
import { readSmtpHostValue, withDevSmtpSink } from "./lib/smtp-env.js";

const ROOT = resolve(import.meta.dirname!, "..");
const ENV_PATH = resolve(ROOT, ".env");
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");
const WEB_ENV_PATH = resolve(ROOT, "apps/web/.env");
const WEB_ENV_EXAMPLE_PATH = resolve(ROOT, "apps/web/.env.example");

function log(msg: string) {
  console.log(`[setup] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(1);
}

function run(command: string, args: string[]) {
  log(`running: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`command failed: ${command} ${args.join(" ")}`);
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    cwd: ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function detectCrossPlatformPnpmHome(pnpmHome: string): string | null {
  const normalized = pnpmHome.replace(/\\/g, "/");
  if (process.platform === "linux" && normalized.startsWith("/Users/")) {
    return "macOS-style /Users path on Linux/WSL";
  }
  if (process.platform === "linux" && /^\/mnt\/[a-z]\/Users\//i.test(normalized)) {
    return "Windows home mounted into WSL";
  }
  if (process.platform === "darwin" && normalized.startsWith("/home/")) {
    return "Linux-style /home path on macOS";
  }
  if (process.platform !== "win32" && /^[A-Za-z]:\//.test(normalized)) {
    return "Windows drive path in a Unix-like shell";
  }
  return null;
}

function checkPnpmHome() {
  const pnpmHome = process.env.PNPM_HOME;
  if (!pnpmHome) return;

  const mismatch = detectCrossPlatformPnpmHome(pnpmHome);
  if (!mismatch) return;

  fail(
    `PNPM_HOME points at ${pnpmHome} (${mismatch}). ` +
      "Unset PNPM_HOME in this shell, then remove or fix the stale export in your shell profile. " +
      "On Linux/WSL, either leave PNPM_HOME unset or set it to $HOME/.local/share/pnpm.",
  );
}

// ---------------------------------------------------------------------------
// 1. Copy .env.example -> .env
// ---------------------------------------------------------------------------
function ensureEnvFile() {
  if (existsSync(ENV_PATH)) {
    log(".env already exists — leaving it alone");
    return;
  }
  if (!existsSync(ENV_EXAMPLE_PATH)) {
    fail(".env.example not found at repo root");
  }
  const template = readFileSync(ENV_EXAMPLE_PATH, "utf-8");
  writeFileSync(ENV_PATH, template, "utf-8");
  log("created .env from .env.example");
}

// ---------------------------------------------------------------------------
// 2. Copy apps/web/.env.example -> apps/web/.env
//
// apps/web/.env.example is all-optional (every VITE_ var is commented out),
// so copying it verbatim is a safe, runnable default. Without this file the
// web app still boots, but onboarding docs previously made this a manual step
// the user had to remember — fold it into `pnpm run setup` instead.
// ---------------------------------------------------------------------------
function ensureWebEnvFile() {
  if (existsSync(WEB_ENV_PATH)) {
    log("apps/web/.env already exists — leaving it alone");
    return;
  }
  if (!existsSync(WEB_ENV_EXAMPLE_PATH)) {
    fail("apps/web/.env.example not found");
  }
  const template = readFileSync(WEB_ENV_EXAMPLE_PATH, "utf-8");
  writeFileSync(WEB_ENV_PATH, template, "utf-8");
  log("created apps/web/.env from apps/web/.env.example");
}

// ---------------------------------------------------------------------------
// 4. Generate BETTER_AUTH_SECRET if missing/empty
// ---------------------------------------------------------------------------
function ensureBetterAuthSecret() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const lines = contents.split("\n");
  let touched = false;
  let foundLine = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Skip pure comment lines.
    if (line.trim().startsWith("#")) continue;
    const match = line.match(/^(\s*)BETTER_AUTH_SECRET\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    foundLine = true;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    if (value.length > 0) {
      log("BETTER_AUTH_SECRET already set — leaving it alone");
      return;
    }
    const secret = randomBytes(32).toString("base64");
    lines[i] = `${match[1]}BETTER_AUTH_SECRET=${secret}`;
    touched = true;
    log("generated and wrote a new BETTER_AUTH_SECRET");
    break;
  }

  if (!foundLine) {
    // Append it if the line was missing entirely.
    const secret = randomBytes(32).toString("base64");
    lines.push(`BETTER_AUTH_SECRET=${secret}`);
    touched = true;
    log("BETTER_AUTH_SECRET line was missing — appended a generated value");
  }

  if (touched) {
    writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 4b. Mint COCKPIT_CONTEXT_ENCRYPTION_KEYS if missing/empty
//
// SSH private keys are encrypted at rest under this keyring. An existing value
// is left alone: replacing it would make every stored key unreadable.
// ---------------------------------------------------------------------------
function ensureEncryptionKeyring() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  if (readEncryptionKeyringValue(contents) !== null) {
    log("COCKPIT_CONTEXT_ENCRYPTION_KEYS already set — leaving it alone");
    return;
  }
  writeFileSync(ENV_PATH, withEncryptionKeyring(contents), "utf-8");
  log("generated and wrote a new COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring");
}

// ---------------------------------------------------------------------------
// 5. Ask for the developer's email -> ADMIN_EMAILS in .env
//
// This is the gap that leaves a fresh clone unable to sign in: SIGNUP_ENABLED
// defaults false and ADMIN_EMAILS defaults empty, so without this step the
// developer's first local sign-up fails with no admin ever bootstrapped
// (packages/env/src/server.ts prints a boot-time warning, but nobody watches
// server logs before they've signed up). Asking here, once, up front, is the
// same admin-bootstrap mechanism used in production (an ADMIN_EMAILS address
// signing up gets promoted by the Better-Auth database hook) — this step
// only fills in the value locally.
//
// Non-interactive use (CI, agents, scripted installs): pass
// `--admin-email <addr>` or set the ADMIN_EMAIL process env. Neither is a
// new app env var — ADMIN_EMAIL is read directly here, the same way
// checkPnpmHome() above reads PNPM_HOME, and only ever becomes the real
// ADMIN_EMAILS value written into .env.
// ---------------------------------------------------------------------------
function parseAdminEmailFlag(argv: string[]): string | null {
  const index = argv.indexOf("--admin-email");
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && value.length > 0 ? value : null;
}

async function promptForAdminEmail(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "Your email address. You'll sign up with it to become the first admin " +
        "(leave blank to skip): ",
    );
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : null;
  } finally {
    rl.close();
  }
}

async function ensureAdminEmail() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  if (readAdminEmailsValue(contents) !== null) {
    log("ADMIN_EMAILS is already set in .env — leaving it alone");
    return;
  }

  const flagEmail = parseAdminEmailFlag(process.argv.slice(2));
  const envEmail = process.env.ADMIN_EMAIL;
  let rawEmail: string | null;

  if (flagEmail) {
    rawEmail = flagEmail;
  } else if (envEmail) {
    rawEmail = envEmail;
  } else if (!process.stdin.isTTY) {
    log(
      "Skipping admin email setup (no interactive terminal). To finish: add " +
        "ADMIN_EMAILS=<your email> to .env yourself, or re-run " +
        "`pnpm run setup --admin-email <you@example.com>`.",
    );
    return;
  } else {
    rawEmail = await promptForAdminEmail();
    if (!rawEmail) {
      log(
        "Skipping admin email setup — add ADMIN_EMAILS=<your email> to .env " +
          "later, then restart the dev server, to sign up as the first admin.",
      );
      return;
    }
  }

  const normalized = rawEmail.trim().toLowerCase();
  if (!looksLikeEmail(normalized)) {
    log(
      `"${rawEmail.trim()}" doesn't look like an email address — skipping ADMIN_EMAILS setup. ` +
        "Add ADMIN_EMAILS=<your email> to .env yourself when ready.",
    );
    return;
  }

  writeFileSync(ENV_PATH, withAdminEmail(contents, normalized), "utf-8");
  log(
    `Wrote ADMIN_EMAILS=${normalized} to .env — sign up with that address and the [bootstrap] token the server prints at startup to become the first admin.`,
  );
}

// ---------------------------------------------------------------------------
// 6. Point SMTP_* at the local mailpit sink
//
// Email verification is enforced on signup, so a fresh clone with no SMTP
// config can never complete first login — the verification link has nowhere
// to land. The dev compose stack runs a mailpit sink on localhost:1025; this
// step activates the SMTP_* lines in .env to use it. A developer who later
// configures a real provider is never overwritten (withDevSmtpSink is a no-op
// when SMTP_HOST has a value).
// ---------------------------------------------------------------------------
function ensureDevSmtp() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const current = readSmtpHostValue(contents);
  if (current !== null) {
    log(`SMTP_HOST already set (${current}) — leaving it alone`);
    return;
  }
  writeFileSync(ENV_PATH, withDevSmtpSink(contents), "utf-8");
  log("pointed SMTP_* at the local mailpit sink (SMTP_HOST=localhost:1025)");
}

// ---------------------------------------------------------------------------
// 7. Start Docker services — Postgres + mailpit
//
// Uses `pnpm dev:services` (root docker-compose.dev.yml), the canonical
// local-services command referenced everywhere else in the docs.
// ---------------------------------------------------------------------------
function startDocker() {
  run("pnpm", ["dev:services"]);
}

// ---------------------------------------------------------------------------
// 8. Wait for Postgres (+ the mail sink when we pointed .env at it)
// ---------------------------------------------------------------------------
function parseEnvUrl(varName: string, defaultPort: number): { host: string; port: number } | null {
  const contents = readFileSync(ENV_PATH, "utf-8");
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(new RegExp(`^${varName}\\s*=\\s*(.*)$`));
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!value) return null;
    try {
      const url = new URL(value);
      const host = url.hostname || "localhost";
      const port = url.port ? Number(url.port) : defaultPort;
      return { host, port };
    } catch {
      return null;
    }
  }
  return null;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForService(
  label: string,
  envVar: string,
  defaultPort: number,
  containerHint: string,
) {
  const target = parseEnvUrl(envVar, defaultPort);
  if (!target) {
    log(`could not parse ${envVar} — skipping ${label} readiness wait`);
    return;
  }
  await waitForHostPort(label, target.host, target.port, containerHint);
}

async function waitForHostPort(label: string, host: string, port: number, containerHint: string) {
  log(`waiting for ${label} at ${host}:${port} (up to 30s)`);
  const deadline = Date.now() + 30_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const ok = await tcpProbe(host, port, 1500);
    if (ok) {
      log(`${label} is accepting connections (after ${attempt} attempt(s))`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(
    `${label} did not become ready within 30s at ${host}:${port}. ` +
      `Check Docker is running and \`docker ps\` shows the ${containerHint} container.`,
  );
}

// ---------------------------------------------------------------------------
// 9. Apply schema
// ---------------------------------------------------------------------------
function applySchema() {
  run("pnpm", ["db:migrate:apply"]);
}

// ---------------------------------------------------------------------------
// 10. Check global portless CLI
// ---------------------------------------------------------------------------
function checkPortless() {
  if (commandExists("portless")) {
    log("portless is available — `pnpm dev` will use https://cockpit-context.localhost");
    return;
  }
  log(
    "portless is not installed. Install it globally with `npm install -g portless` " +
      "before running `pnpm dev`, or use `pnpm dev:raw` as the manual-port fallback.",
  );
}

/** Read the SMTP_HOST/SMTP_PORT pair from .env, or null when unset. */
function readSmtpTarget(): { host: string; port: number } | null {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const host = readSmtpHostValue(contents);
  if (host === null) return null;
  let port = 1025;
  for (const raw of contents.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const match = raw.match(/^\s*SMTP_PORT\s*=\s*(\d+)\s*$/);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  return { host, port };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("starting first-run setup");
  checkPnpmHome();
  ensureEnvFile();
  ensureWebEnvFile();
  ensureBetterAuthSecret();
  ensureEncryptionKeyring();
  await ensureAdminEmail();
  ensureDevSmtp();
  startDocker();
  await waitForService("Postgres", "DATABASE_URL", 5432, "postgres");
  // Wait for the mail sink only when .env actually points at one — a real
  // provider configured by the developer is not ours to probe.
  const smtpTarget = readSmtpTarget();
  if (smtpTarget?.host === "localhost" || smtpTarget?.host === "127.0.0.1") {
    await waitForHostPort("Mailpit (mail sink)", smtpTarget.host, smtpTarget.port, "mailpit");
  }
  applySchema();
  checkPortless();
  installClaudeHooks();
  log("Next: set OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL in .env to enable investigations.");
  log("Ready. Run `pnpm dev` to start.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
