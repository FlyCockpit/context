/** Defaults for model-dispatch retry (per candidate model). */
export const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 3;
export const DEFAULT_MAX_WAIT_MS = 15_000;
const DEFAULT_BASE_DELAY_MS = 500;
/** Primary + up to 3 fallbacks. */
export const MAX_FAILOVER_CANDIDATES = 4;

const getStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return undefined;
};

const getMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? "");

/**
 * Whether a model-dispatch failure is worth retrying / failing over.
 * Retry: 429, 502, 503, 504, network/timeout, unknown status.
 * Fail-fast: other 4xx (auth/validation).
 */
export const isTransientModelError = (error: unknown): boolean => {
  const status = getStatus(error);
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (status !== undefined && status >= 500) return true;

  const message = getMessage(error).toLowerCase();
  if (
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("timeout")
  ) {
    return true;
  }
  // Unknown status / shape — treat as transient (matches toRuntimeError retryable:true).
  return status === undefined;
};

/**
 * Parse a Retry-After header value (seconds or HTTP-date) into a delay in ms.
 * Returns undefined when missing/unparseable.
 */
export const parseRetryAfterMs = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const headers =
    "headers" in error && error.headers && typeof error.headers === "object"
      ? (error.headers as Record<string, unknown>)
      : "response" in error &&
          error.response &&
          typeof error.response === "object" &&
          "headers" in error.response &&
          error.response.headers &&
          typeof error.response.headers === "object"
        ? (error.response.headers as Record<string, unknown>)
        : undefined;
  if (!headers) return undefined;
  const raw =
    headers["retry-after"] ??
    headers["Retry-After"] ??
    (typeof (headers as { get?: (k: string) => unknown }).get === "function"
      ? (headers as { get: (k: string) => unknown }).get("retry-after")
      : undefined);
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const dateMs = Date.parse(text);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
};

/**
 * Full-jitter exponential backoff delay for attempt index (0-based), capped at maxWaitMs.
 * When `retryAfterMs` is set, use min(retryAfter, maxWait).
 */
export const computeBackoffMs = (
  attemptIndex: number,
  options?: {
    baseDelayMs?: number;
    maxWaitMs?: number;
    retryAfterMs?: number;
    random?: () => number;
  },
): number => {
  const base = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxWait = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const random = options?.random ?? Math.random;
  if (options?.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, options.retryAfterMs), maxWait);
  }
  const exp = Math.min(maxWait, base * 2 ** attemptIndex);
  return Math.floor(random() * exp);
};

/** Sleep that rejects promptly when `signal` aborts. */
export const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const getErrorStatus = getStatus;
