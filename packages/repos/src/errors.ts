/**
 * Every failure the git layer reports to a caller. `code` is the stable,
 * machine-readable contract: the routers map it to an ORPCError and a
 * translated message, and the job handlers use `permanent` to decide whether a
 * retry can help. `message` is English operator detail (logs, `lastError`),
 * never a user-facing string, and never contains key material.
 */
export type RepoErrorCode =
  /** The remote URL is malformed, uses a refused scheme, or carries userinfo. */
  | "INVALID_REMOTE_URL"
  /** The remote host is (or resolves to) a loopback/private/link-local/metadata address. */
  | "PRIVATE_ADDRESS"
  /** DNS lookup for the remote host failed. */
  | "HOST_UNRESOLVABLE"
  /** An SSH remote needs an SSH key and none was given. */
  | "SSH_KEY_REQUIRED"
  /** The SSH key does not exist or is not the caller's. */
  | "SSH_KEY_NOT_FOUND"
  /** The SSH key is still referenced by a package. */
  | "SSH_KEY_IN_USE"
  /** The pasted private key could not be parsed. */
  | "SSH_KEY_INVALID"
  /** The pasted private key is passphrase-protected and no passphrase was given. */
  | "SSH_KEY_PASSPHRASE_REQUIRED"
  /** The passphrase does not decrypt the pasted private key. */
  | "SSH_KEY_PASSPHRASE_INVALID"
  /** The passphrase is longer than the 1023 UTF-8 bytes OpenSSH reads from askpass. */
  | "SSH_KEY_PASSPHRASE_TOO_LONG"
  /** The passphrase holds a CR, LF or NUL, where OpenSSH would cut it short. */
  | "SSH_KEY_PASSPHRASE_LINE_BREAK"
  /** The key type is not one we accept (DSA, unknown). */
  | "SSH_KEY_UNSUPPORTED"
  /** The caller already has a key with this fingerprint. */
  | "SSH_KEY_DUPLICATE"
  /** `COCKPIT_CONTEXT_ENCRYPTION_KEYS` is unset, or lacks the version a row was written with. */
  | "ENCRYPTION_UNAVAILABLE"
  /** The stored SSH key failed GCM authentication (tampered, moved between rows, or wrong key bytes). */
  | "SSH_KEY_UNREADABLE"
  /** No pinned or user-confirmed host key for an SSH host: confirm one first. */
  | "HOST_KEY_UNCONFIRMED"
  /** The host name or port given for a host-key scan or confirmation is invalid. */
  | "INVALID_HOST"
  /** `ssh-keyscan` returned no usable keys. */
  | "HOST_SCAN_FAILED"
  /** The known-host row does not exist or is not the caller's. */
  | "KNOWN_HOST_NOT_FOUND"
  /** A ref or version string is not something we will hand to git. */
  | "INVALID_REF"
  /** Neither a tag, a branch nor a commit matched `ref`. */
  | "REF_NOT_FOUND"
  | "PACKAGE_SNAPSHOT_REF_MISSING"
  /** No candidate tag (or npm gitHead) matched `version`. */
  | "VERSION_NOT_FOUND"
  /** The repository row does not exist. */
  | "REPOSITORY_NOT_FOUND"
  /** The checkout row does not exist. */
  | "CHECKOUT_NOT_FOUND"
  /** A run holds a lease on the checkout; it cannot be deleted now. */
  | "CHECKOUT_LEASED"
  /** git exited non-zero (clone/fetch/worktree). */
  | "GIT_FAILED"
  /** git ran past its time budget and was killed. */
  | "GIT_TIMEOUT";

export type RepoErrorDetails = {
  /** Up to 10 semver-sorted tag names near the requested version. */
  nearestTags?: string[];
  /** For HOST_KEY_UNCONFIRMED: the host and port to confirm. */
  host?: string;
  port?: number;
  /** For INVALID_REMOTE_URL: which rule failed. */
  reason?: string;
};

/** Codes a retry can never fix; job handlers turn them into PermanentJobError. */
const PERMANENT_CODES: ReadonlySet<RepoErrorCode> = new Set<RepoErrorCode>([
  "INVALID_REMOTE_URL",
  "PRIVATE_ADDRESS",
  "SSH_KEY_REQUIRED",
  "SSH_KEY_NOT_FOUND",
  "SSH_KEY_INVALID",
  "SSH_KEY_UNSUPPORTED",
  "ENCRYPTION_UNAVAILABLE",
  "SSH_KEY_UNREADABLE",
  "HOST_KEY_UNCONFIRMED",
  "INVALID_REF",
  "REPOSITORY_NOT_FOUND",
  "PACKAGE_SNAPSHOT_REF_MISSING",
  "CHECKOUT_NOT_FOUND",
]);

export class RepoError extends Error {
  readonly code: RepoErrorCode;
  readonly details: RepoErrorDetails;

  constructor(
    code: RepoErrorCode,
    message: string,
    details: RepoErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RepoError";
    this.code = code;
    this.details = details;
  }

  get permanent(): boolean {
    return PERMANENT_CODES.has(this.code);
  }
}

export function isRepoError(error: unknown): error is RepoError {
  return error instanceof RepoError;
}

/** Longest error text kept on a row (`Repository.lastError`, `Checkout.lastError`). */
export const MAX_LAST_ERROR_LENGTH = 2_000;

export function lastErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_LAST_ERROR_LENGTH ? `${text.slice(0, MAX_LAST_ERROR_LENGTH)}…` : text;
}
