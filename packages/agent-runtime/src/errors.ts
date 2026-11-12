export class FatalToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalToolError";
  }
}

export class AgentRuntimeError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AgentRuntimeError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** `RUN_ERROR` codes that name a request the provider will refuse again unchanged. */
const NON_RETRYABLE_RUN_ERROR_CODES: Record<string, number> = { context_overflow: 400 };

/**
 * The error a `RUN_ERROR` chunk stands for. The TanStack adapters catch a failed provider
 * call and yield it as that chunk instead of throwing, carrying only `message` and a `code`
 * (the HTTP status as a string, when there was one). This turns it back into a thrown error
 * with a numeric `status`, so the retry rules (`isTransientModelError`) and the run
 * engine's classification see what they would have seen from a throw. `code: "aborted"`
 * becomes an `AbortError`.
 */
export const errorFromRunErrorChunk = (chunk: {
  message?: unknown;
  code?: unknown;
  error?: unknown;
  rawEvent?: unknown;
}): Error => {
  const asRecord = (value: unknown): { message?: unknown; code?: unknown } =>
    typeof value === "object" && value !== null ? value : {};
  const nested = asRecord(chunk.error);
  // The OpenRouter adapters leave the code out of the chunk's own fields when the
  // provider's error arrived as a stream event; that event is `rawEvent`, `code` numeric.
  const code = [nested.code, chunk.code, asRecord(chunk.rawEvent).code]
    .map((value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : value))
    .find((value): value is string => typeof value === "string");
  const message = [nested.message, chunk.message].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (code === "aborted") return Object.assign(new Error("aborted"), { name: "AbortError" });
  const status =
    code !== undefined && /^\d{3}$/.test(code)
      ? Number(code)
      : code !== undefined
        ? NON_RETRYABLE_RUN_ERROR_CODES[code]
        : undefined;
  return Object.assign(new Error(message ?? "Model request failed"), {
    name: "ModelRunError",
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  });
};
