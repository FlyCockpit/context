/**
 * Map an unknown error (oRPC ORPCError, fetch error, thrown Error) to safe
 * user-facing copy. Never returns `error.message` — that may contain raw
 * Prisma / auth.api / third-party SDK strings. See docs/development.md.
 *
 * Mapped copy lives in the `errors` locale namespace so every locale gets it.
 * Pass an optional `fallback` for context-specific copy ("Couldn't update
 * that user. Try again."). It is used only when we have no specific code
 * mapping; known codes (CONFLICT, FORBIDDEN, …) still return their mapped
 * copy, and so does a network failure (offline / server unreachable), which
 * says what to do instead of "Something didn't work".
 *
 * Domain errors carry a stable `data.reason` (`PACKAGE_EXISTS`,
 * `PRIVATE_ADDRESS`, … from `packages/api/src/lib/domain-errors.ts`). A reason
 * with copy under `errors:reasons.<REASON>` wins over the code mapping; an
 * unknown reason falls through to it.
 */
import i18n from "../i18n";
import { networkFailureKind } from "../lib/network-failure";

export function friendly(error: unknown, fallback?: string): string {
  const e = asErrorShape(error);
  const generic = fallback ?? i18n.t("errors:generic");

  const network = networkFailureKind(error);
  if (network === "offline") return i18n.t("errors:offline");
  if (network === "unreachable") return i18n.t("errors:unreachable");

  if (!e) return generic;

  if (e.code === "TOO_MANY_REQUESTS" || e.status === 429) {
    // The engine's queued-run cap (reason BUSY) says what to do: wait for
    // answers. Every other 429 is a rate limit and says when to retry.
    if (errorReason(error) === "BUSY" && i18n.exists("errors:reasons.BUSY")) {
      return i18n.t("errors:reasons.BUSY");
    }
    const retryAfter = getRetryAfter(e);
    return retryAfter !== null
      ? i18n.t("errors:rateLimitedWithSeconds", { seconds: retryAfter })
      : i18n.t("errors:rateLimited");
  }

  const reason = errorReason(error);
  if (reason) {
    const key = `errors:reasons.${reason}`;
    if (i18n.exists(key)) return i18n.t(key);
  }

  if (e.code === "UNAUTHORIZED" || e.status === 401) {
    return i18n.t("errors:sessionEnded");
  }
  if (e.code === "FORBIDDEN" || e.status === 403) {
    return i18n.t("errors:forbidden");
  }
  if (e.code === "NOT_FOUND" || e.status === 404) {
    return i18n.t("errors:notFound");
  }
  if (e.code === "CONFLICT" || e.status === 409) {
    return i18n.t("errors:conflict");
  }
  if (e.code === "BAD_REQUEST" || e.status === 400) {
    return i18n.t("errors:badRequest");
  }
  if (e.code === "INTERNAL_SERVER_ERROR" || (typeof e.status === "number" && e.status >= 500)) {
    return fallback ?? i18n.t("errors:serverError");
  }

  return generic;
}

/** The stable `data.reason` code a domain error carries, if any. */
export function errorReason(error: unknown): string | null {
  const e = asErrorShape(error);
  if (!e?.data || typeof e.data !== "object") return null;
  const reason = (e.data as { reason?: unknown }).reason;
  return typeof reason === "string" && /^[A-Z][A-Z0-9_]*$/.test(reason) ? reason : null;
}

/** The oRPC error code (`NOT_FOUND`, `CONFLICT`, …), if the error carries one. */
export function errorCode(error: unknown): string | null {
  const code = asErrorShape(error)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * True if the error looks like a 429 / TOO_MANY_REQUESTS response from oRPC.
 */
export function isRateLimit(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 429 || e.code === "TOO_MANY_REQUESTS";
}

/**
 * True for Better-Auth's answer to a wrong email or password (401
 * `INVALID_EMAIL_OR_PASSWORD`). Only that belongs under the sign-in password
 * field: a field error blocks resubmitting until the field changes, which is
 * wrong for a server error or a rate limit (docs/ui.md § Server errors on a field).
 */
export function isCredentialRejection(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  // The code, not the status: Better-Auth also answers 401
  // FAILED_TO_CREATE_SESSION after accepting the credentials.
  return e.code === "INVALID_EMAIL_OR_PASSWORD";
}

/**
 * True for Better-Auth's answer to a wrong or expired one-time code (2FA app
 * code, emailed code, backup code). Only that belongs under the code field;
 * a rate limit, a lockout, an expired 2FA session or a server/network failure
 * is not the code's fault and goes to `friendly()` instead.
 */
export function isCodeRejection(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return (
    e.code === "INVALID_CODE" || e.code === "INVALID_BACKUP_CODE" || e.code === "OTP_HAS_EXPIRED"
  );
}

/**
 * True for Better-Auth's answer to a sign-up for an address that already has
 * an account: 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (or the older
 * `USER_ALREADY_EXISTS`, or a 409). Only an instance without SMTP sends it:
 * with email verification on, Better-Auth answers a registered address with
 * the same neutral success as a free one (packages/auth/src/signup-response.ts),
 * so this never turns the neutral answer into an account-enumeration oracle.
 */
export function isAccountExistsRejection(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return (
    e.code === "USER_ALREADY_EXISTS" ||
    e.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
    e.status === 409
  );
}

type ErrorShape = {
  status?: number;
  code?: string;
  data?: unknown;
  cause?: unknown;
  message?: string;
};

function asErrorShape(error: unknown): ErrorShape | null {
  if (!error || typeof error !== "object") return null;
  return error as ErrorShape;
}

function getRetryAfter(e: ErrorShape): number | null {
  const fromData =
    e.data && typeof e.data === "object" && "retryAfter" in e.data
      ? (e.data as { retryAfter?: unknown }).retryAfter
      : undefined;
  const fromCause =
    e.cause && typeof e.cause === "object" && "retryAfter" in e.cause
      ? (e.cause as { retryAfter?: unknown }).retryAfter
      : undefined;
  const raw = fromData ?? fromCause;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
