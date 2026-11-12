import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { BOOTSTRAP_TOKEN_HEADER } from "./signup-policy.js";

export { BOOTSTRAP_TOKEN_HEADER };

/**
 * One-time first-admin bootstrap token (docs/deploy.md § First administrator: private access before public exposure).
 *
 * While no account exists and ADMIN_EMAILS is set, the server issues one
 * random token at startup and prints it to the boot log once. The first-admin
 * signup must present it in {@link BOOTSTRAP_TOKEN_HEADER}; knowing a listed
 * address is not enough. The token lives in this process's memory only, as a
 * SHA-256 digest: a restart issues a new one (the old one stops working), and
 * it is cleared as soon as any account exists, after which the bootstrap is
 * closed for good.
 *
 * Nothing in this module logs the token; {@link issueBootstrapTokenIfNeeded}
 * prints it exactly once through the injected logger. The header
 * ({@link BOOTSTRAP_TOKEN_HEADER}) is never logged: the request log records
 * no headers.
 */
const TOKEN_BYTES = 32;
// Upper bound on what is hashed for comparison, so an oversized header costs
// nothing extra. A real token is 43 base64url characters.
const MAX_CANDIDATE_LENGTH = 256;

let activeDigest: Buffer | null = null;
// Compared against when no token is active, so verification takes the same
// path whether or not a token exists.
const PLACEHOLDER_DIGEST = createHash("sha256").update(randomBytes(TOKEN_BYTES)).digest();

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Issue a fresh token, replacing any previous one. Returns the plaintext once. */
export function issueBootstrapToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  activeDigest = digest(token);
  return token;
}

/** Whether an unconsumed token exists in this process. */
export function isBootstrapTokenActive(): boolean {
  return activeDigest !== null;
}

/**
 * Constant-time check of a presented token. Both sides are SHA-256 digests,
 * so `timingSafeEqual` always compares 32 bytes whatever the input length.
 */
export function verifyBootstrapToken(candidate: unknown): boolean {
  const expected = activeDigest;
  const presented =
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_CANDIDATE_LENGTH
      ? candidate
      : "";
  const equal = timingSafeEqual(digest(presented), expected ?? PLACEHOLDER_DIGEST);
  return equal && expected !== null && presented !== "";
}

/** Clear the token. Called once any account exists: the bootstrap is closed. */
export function revokeBootstrapToken(): void {
  activeDigest = null;
}

/**
 * Startup step: issue and print a token when the bootstrap is possible
 * (ADMIN_EMAILS set and no account yet). Returns whether one was issued.
 */
export async function issueBootstrapTokenIfNeeded(deps: {
  adminEmailCount: number;
  countUsers: () => Promise<number>;
  log: (message: string) => void;
}): Promise<boolean> {
  revokeBootstrapToken();
  if (deps.adminEmailCount === 0) return false;
  if ((await deps.countUsers()) > 0) return false;
  const token = issueBootstrapToken();
  deps.log(
    [
      "[bootstrap] No account exists yet. One-time first-admin bootstrap token:",
      `[bootstrap]   ${token}`,
      "[bootstrap] Open /signup, sign up with an ADMIN_EMAILS address and paste this token.",
      "[bootstrap] It works once, only until the first account exists, and is replaced on every restart.",
    ].join("\n"),
  );
  return true;
}
