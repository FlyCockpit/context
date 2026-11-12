import { isRepoError, type RepoErrorCode } from "@cockpit-context/repos/errors";
import { isRunEngineError, type RunEngineErrorCode } from "@cockpit-context/runs/errors";
import { ORPCError } from "@orpc/server";

/**
 * Map the git layer's `RepoError` and the run engine's `RunEngineError` to an
 * ORPCError at the procedure boundary.
 *
 * The wire contract is `data.reason` — the stable machine code the web app
 * translates (docs/development.md: the client never renders
 * `error.message`). `message` is a fixed English sentence per code, never the
 * domain error's own message, which can carry git stderr, host names or
 * paths. Only allowlisted details travel (`nearestTags`, the host/port to
 * confirm, which URL rule failed).
 */

type DomainCode = RepoErrorCode | RunEngineErrorCode;

type OrpcCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "BAD_GATEWAY"
  | "GATEWAY_TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "TOO_MANY_REQUESTS";

const MAPPING: Record<DomainCode, { code: OrpcCode; message: string }> = {
  INVALID_REMOTE_URL: { code: "BAD_REQUEST", message: "That git URL is not supported." },
  PRIVATE_ADDRESS: {
    code: "BAD_REQUEST",
    message: "That host points at a private or local address.",
  },
  HOST_UNRESOLVABLE: { code: "BAD_REQUEST", message: "That host name could not be found." },
  SSH_KEY_REQUIRED: { code: "BAD_REQUEST", message: "SSH git URLs need an SSH key." },
  SSH_KEY_NOT_FOUND: { code: "NOT_FOUND", message: "SSH key not found." },
  SSH_KEY_IN_USE: { code: "CONFLICT", message: "That SSH key is still used by a package." },
  SSH_KEY_INVALID: { code: "BAD_REQUEST", message: "That private key could not be read." },
  SSH_KEY_PASSPHRASE_REQUIRED: {
    code: "BAD_REQUEST",
    message: "That private key needs its passphrase.",
  },
  SSH_KEY_PASSPHRASE_INVALID: {
    code: "BAD_REQUEST",
    message: "That passphrase does not unlock the key.",
  },
  SSH_KEY_PASSPHRASE_TOO_LONG: {
    code: "BAD_REQUEST",
    message: "Passphrases longer than 1023 bytes are not supported.",
  },
  SSH_KEY_PASSPHRASE_LINE_BREAK: {
    code: "BAD_REQUEST",
    message: "Passphrases with line breaks are not supported.",
  },
  SSH_KEY_UNSUPPORTED: { code: "BAD_REQUEST", message: "That key type is not supported." },
  SSH_KEY_DUPLICATE: { code: "CONFLICT", message: "You already have this SSH key." },
  ENCRYPTION_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    message: "This server is not set up to store SSH keys.",
  },
  SSH_KEY_UNREADABLE: {
    code: "CONFLICT",
    message: "That stored SSH key can no longer be read. Replace it.",
  },
  HOST_KEY_UNCONFIRMED: {
    code: "PRECONDITION_FAILED",
    message: "Confirm this host's SSH key first.",
  },
  INVALID_HOST: { code: "BAD_REQUEST", message: "That host or port is not valid." },
  HOST_SCAN_FAILED: { code: "BAD_GATEWAY", message: "That host returned no SSH host keys." },
  KNOWN_HOST_NOT_FOUND: { code: "NOT_FOUND", message: "Known host not found." },
  INVALID_REF: { code: "BAD_REQUEST", message: "That is not a valid tag, branch or commit." },
  PACKAGE_SNAPSHOT_REF_MISSING: {
    code: "BAD_REQUEST",
    message:
      "This version is unavailable. Update the snapshot with your SSH key in Cockpit Context.",
  },
  REF_NOT_FOUND: { code: "BAD_REQUEST", message: "No tag, branch or commit matched that ref." },
  VERSION_NOT_FOUND: { code: "BAD_REQUEST", message: "No tag matched that version." },
  REPOSITORY_NOT_FOUND: { code: "NOT_FOUND", message: "Repository not found." },
  CHECKOUT_NOT_FOUND: { code: "NOT_FOUND", message: "Checkout not found." },
  CHECKOUT_LEASED: {
    code: "CONFLICT",
    message: "A running investigation is using this checkout.",
  },
  GIT_FAILED: { code: "BAD_GATEWAY", message: "The git server refused or failed the request." },
  GIT_TIMEOUT: { code: "GATEWAY_TIMEOUT", message: "The git server took too long to answer." },
  PACKAGE_NOT_FOUND: { code: "NOT_FOUND", message: "Package not found." },
  CONVERSATION_NOT_FOUND: { code: "NOT_FOUND", message: "Conversation not found." },
  RUN_NOT_FOUND: { code: "NOT_FOUND", message: "Run not found." },
  RUN_FINISHED: { code: "CONFLICT", message: "That run has already finished." },
  RUN_ACTIVE: { code: "CONFLICT", message: "That conversation is still running." },
  BUSY: {
    code: "TOO_MANY_REQUESTS",
    message: "Too many of your questions are waiting for an investigation slot.",
  },
  MODEL_NOT_CONFIGURED: {
    code: "SERVICE_UNAVAILABLE",
    message: "No model is configured on this server.",
  },
  ENGINE_STOPPED: {
    code: "SERVICE_UNAVAILABLE",
    message: "The server is restarting. Try again in a moment.",
  },
};

/** The data a domain error carries to the client. Allowlisted fields only. */
export type DomainErrorData = {
  reason: DomainCode;
  nearestTags?: string[];
  host?: string;
  port?: number;
  rule?: string;
};

/** The ORPCError for a domain error, or `null` when `error` is not one. */
export function domainErrorToOrpc(error: unknown): ORPCError<OrpcCode, DomainErrorData> | null {
  if (isRepoError(error)) {
    const mapped = MAPPING[error.code];
    const data: DomainErrorData = { reason: error.code };
    if (error.details.nearestTags) data.nearestTags = error.details.nearestTags.slice(0, 10);
    if (error.code === "HOST_KEY_UNCONFIRMED") {
      if (error.details.host) data.host = error.details.host;
      if (error.details.port) data.port = error.details.port;
    }
    if (error.details.reason) data.rule = error.details.reason;
    return new ORPCError(mapped.code, { message: mapped.message, data, cause: error });
  }
  if (isRunEngineError(error)) {
    const mapped = MAPPING[error.code];
    return new ORPCError(mapped.code, {
      message: mapped.message,
      data: { reason: error.code },
      cause: error,
    });
  }
  return null;
}

/** Run `fn`, translating domain errors; anything else propagates unchanged. */
export async function withDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw domainErrorToOrpc(error) ?? error;
  }
}

/** A procedure-level ORPCError with a stable `data.reason` for the client. */
export function reasonError(
  code: OrpcCode | "FORBIDDEN",
  reason: string,
  message: string,
): ORPCError<string, { reason: string }> {
  return new ORPCError(code, { message, data: { reason } });
}
