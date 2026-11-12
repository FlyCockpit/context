import { createEnv } from "@t3-oss/env-core";
import { resolveCockpitContextDataDir } from "./data-dir.js";
import { env as sharedEnv } from "./shared.js";
import { serverVars } from "./vars/server.js";
import { webVars } from "./vars/web.js";

// ---------------------------------------------------------------------------
// Full server environment.
//
// `extends: [sharedEnv]` merges in everything ./shared.ts already validated
// (database, backups, SMTP, translation) so server-side code keeps seeing a
// single `env` with every field. This module adds only the server-only
// variables and the startup guards that depend on them. Shared packages never
// import this file, so scripts and the SSR graph are not required to set
// BETTER_AUTH_URL, BETTER_AUTH_SECRET, the rate-limit knobs, etc.
//
// The variable declarations themselves live in ./vars/server.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// running the startup guards below. Declare new variables there, never inline
// in the `createEnv` call.
//
// Disjointness contract: no key declared in ./vars/server.ts may also appear in
// ./vars/shared.ts — `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const env = createEnv({
  extends: [sharedEnv],
  server: serverVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

// ---------------------------------------------------------------------------
// Admin emails — parsed once at startup into a Set for O(1) lookups.
// ---------------------------------------------------------------------------
export const ADMIN_EMAILS: Set<string> = new Set(
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export const SSO_ENABLED: boolean = env.SSO_ENABLED;
export const FORCE_SSO: boolean = env.FORCE_SSO;
export const SIGNUP_ENABLED: boolean = env.SIGNUP_ENABLED;

// Server-side display name. VITE_APP_NAME is declared exactly once — in
// ./vars/web.ts (the one-surface rule in scripts/lib/env-schema.ts forbids
// re-declaring it here) — but the server needs it too (seo.ts renders it into
// /llms.txt, and the Docker image carries it as a runtime ENV). This helper
// validates the raw runtime value against that same canonical schema instead
// of reading process.env inline, so an overlong/mistyped value fails fast at
// boot like every other env var instead of shipping into public SEO files.
// Empty string counts as unset: the Dockerfile defaults the build arg to ""
// and always exports the ENV, so "" is the common "not configured" shape.
export function resolveAppName(raw: string | undefined = process.env.VITE_APP_NAME): string {
  return webVars.VITE_APP_NAME.parse(raw || undefined) ?? "Cockpit Context";
}

// ---------------------------------------------------------------------------
// BETTER_AUTH_SECRET entropy check — catch weak/placeholder secrets early.
// ---------------------------------------------------------------------------
const WEAK_PLACEHOLDERS = [
  "changeme",
  "secret",
  "password",
  "your-secret-here",
  "replace-me",
  "placeholder",
];

function isWeakSecret(secret: string): string | null {
  // All-same-character strings (e.g. "aaaaaaaaaa…")
  if (new Set(secret).size === 1) {
    return "all characters are identical";
  }
  // Repeating hex-like patterns (e.g. "xxxxxxxx…", "00000000…")
  if (/^(.)\1+$/.test(secret) || /^(..)\1+$/.test(secret)) {
    return "repeating pattern detected";
  }
  // Known placeholder words (case-insensitive)
  const lower = secret.toLowerCase();
  for (const placeholder of WEAK_PLACEHOLDERS) {
    if (lower === placeholder || lower.includes(placeholder)) {
      return `contains placeholder word "${placeholder}"`;
    }
  }
  // Fewer than 10 distinct characters → low entropy
  if (new Set(secret).size < 10) {
    return `only ${new Set(secret).size} distinct characters (need at least 10)`;
  }
  return null;
}

const weakReason = isWeakSecret(env.BETTER_AUTH_SECRET);
if (weakReason) {
  const msg =
    `[env] BETTER_AUTH_SECRET is weak: ${weakReason}. ` +
    "Generate a strong secret with: pnpm generate:secret";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

// Same entropy bar as BETTER_AUTH_SECRET, but only when SSO credentials are
// configured: SSO_CLIENT_SECRET is optional (unset = SSO inert), so an unset
// value must not warn. A weak-but-configured secret is live the moment
// SSO_ENABLED flips on — catch the placeholder before it becomes the IdP
// client secret in production.
if (env.SSO_CLIENT_SECRET) {
  const ssoWeakReason = isWeakSecret(env.SSO_CLIENT_SECRET);
  if (ssoWeakReason) {
    const msg =
      `[env] SSO_CLIENT_SECRET is weak: ${ssoWeakReason}. ` +
      "Generate a strong secret with: openssl rand -hex 32";
    if (env.NODE_ENV === "production") {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

// Admin bootstrap needs a listed email address. Public signup alone never
// grants admin privileges, and SSO/JIT-created users are not auto-promoted.
// This module cannot query existing admins at import time, so an empty list
// warns without blocking a provisioned installation's startup.
if (ADMIN_EMAILS.size === 0 && !SIGNUP_ENABLED) {
  console.warn(
    "[env] SIGNUP_ENABLED=false and ADMIN_EMAILS is empty — no NEW admin can " +
      "be bootstrapped: public signup is disabled, and " +
      "the admin-bootstrap signup path requires an address in ADMIN_EMAILS " +
      "(SSO users are never auto-promoted). If this is a fresh install with no admin " +
      "yet, set ADMIN_EMAILS to a comma-separated list of operator emails, restart, and " +
      "sign up with a listed address plus the [bootstrap] token from the boot log. If admins " +
      "already exist in the database, this warning is expected and safe to ignore.",
  );
} else if (ADMIN_EMAILS.size === 0 && env.NODE_ENV === "production") {
  console.warn(
    "[env] ADMIN_EMAILS is empty — no new admin can use the bootstrap signup path. " +
      "On first boot, set ADMIN_EMAILS and sign up with a listed address plus the " +
      "[bootstrap] token from the boot log. " +
      "Existing admin roles persist in the database.",
  );
}

if (FORCE_SSO && env.NODE_ENV === "production") {
  const missing: string[] = [];
  if (!SSO_ENABLED) missing.push("SSO_ENABLED=true");
  if (!env.SSO_CLIENT_ID) missing.push("SSO_CLIENT_ID");
  if (!env.SSO_CLIENT_SECRET) missing.push("SSO_CLIENT_SECRET");
  if (!env.SSO_ISSUER) missing.push("SSO_ISSUER");
  if (missing.length > 0) {
    throw new Error(
      `[env] FATAL: FORCE_SSO=true in production requires ${missing.join(", ")}. ` +
        "Fix the SSO deployment secrets or unset FORCE_SSO before redeploying.",
    );
  }
}
if (env.SMTP_HOST && !env.SMTP_FROM) {
  const msg =
    "[env] SMTP_HOST is set but SMTP_FROM is not. Outgoing email needs an explicit " +
    'From: address — set SMTP_FROM (e.g. "App Name <no-reply@yourdomain.com>").';
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

if (env.NODE_ENV === "production") {
  if (env.BETTER_AUTH_URL.startsWith("http:")) {
    throw new Error(
      "[env] BETTER_AUTH_URL must use https in production (it drives secure cookies and the canonical SEO origin).",
    );
  }
  if (env.CORS_ORIGIN?.startsWith("http:")) {
    throw new Error("[env] CORS_ORIGIN must use https in production.");
  }
  if (env.PUBLIC_APP_URL?.startsWith("http:")) {
    throw new Error("[env] PUBLIC_APP_URL must use https in production.");
  }
}

// ---------------------------------------------------------------------------
// Cockpit Context: data directory, models, and the at-rest encryption keyring.
// ---------------------------------------------------------------------------

/** Absolute data root (bare clones, worktrees, SSH temp files). */
export const COCKPIT_CONTEXT_DATA_DIR: string = resolveCockpitContextDataDir(
  env.COCKPIT_CONTEXT_DATA_DIR,
  env.NODE_ENV,
);
/** Model for `delegate_explore` helpers; falls back to the main model. */
export const COCKPIT_CONTEXT_HELPER_MODEL: string | undefined =
  env.COCKPIT_CONTEXT_HELPER_MODEL ?? env.COCKPIT_CONTEXT_MODEL;

if (!env.COCKPIT_CONTEXT_ENCRYPTION_KEYS) {
  const msg =
    "[env] COCKPIT_CONTEXT_ENCRYPTION_KEYS is not set. SSH private keys cannot be stored without it. " +
    "Set it to `v1:<base64 32-byte key>` (e.g. `v1:$(openssl rand -base64 32)`); " +
    "`pnpm run setup` writes one into a local .env.";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  if (env.NODE_ENV === "development") console.warn(msg);
}

if (env.OPENROUTER_API_KEY && !env.COCKPIT_CONTEXT_MODEL) {
  const msg =
    "[env] OPENROUTER_API_KEY is set but COCKPIT_CONTEXT_MODEL is not. The investigation agent has no " +
    "default model — set COCKPIT_CONTEXT_MODEL to an OpenRouter model id.";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

if (env.NODE_ENV === "production" && env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL?.startsWith("http:")) {
  throw new Error(
    "[env] COCKPIT_CONTEXT_OPENROUTER_BASE_URL must use https in production. Leave it unset to use " +
      "OpenRouter; an http value is only for the local fake OpenRouter server.",
  );
}

// The Anthropic SDK appends /v1/messages to the API root itself, so the messages API
// needs a base URL whose /v1 it can take off (@cockpit-context/agent-runtime anthropicSdkBaseUrl).
if (
  env.COCKPIT_CONTEXT_MODEL_API === "messages" &&
  env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL &&
  !new URL(env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL).pathname.replace(/\/+$/, "").endsWith("/v1")
) {
  throw new Error(
    "[env] COCKPIT_CONTEXT_MODEL_API=messages needs a COCKPIT_CONTEXT_OPENROUTER_BASE_URL that ends in /v1 " +
      "(the API root, e.g. https://openrouter.ai/api/v1).",
  );
}

// Email is optional: without SMTP, signup creates
// accounts already verified and signs them straight in. That is a supported
// operator choice, so it warns instead of refusing to boot — but it means
// anyone who can reach the server can register any address, unverified.
if (SIGNUP_ENABLED && !env.SMTP_HOST) {
  console.warn(
    "[env] SIGNUP_ENABLED=true without SMTP_HOST: open signup creates accounts " +
      "without email verification, so anyone who can reach this server can register " +
      "any address. Configure SMTP_HOST/SMTP_PORT/SMTP_FROM to require verification, " +
      "or close signup (SIGNUP_ENABLED=false, or the admin settings toggle).",
  );
}
