import type { z } from "zod";

/** Exponential backoff between attempts: `baseMs * 2^(attempt-1)`, capped at `maxMs`. */
export type BackoffPolicy = { baseMs: number; maxMs: number };

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 5_000, maxMs: 15 * 60_000 };
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A job type: its stable name and payload contract. Definitions carry no
 * handler, so producers (oRPC procedures, other jobs) can import them and
 * enqueue type-checked payloads without pulling in the handler's dependencies.
 * The runner pairs each definition with its handler (`handleJob`).
 */
export type JobDefinition<TType extends string = string, TPayload = unknown> = {
  readonly type: TType;
  readonly payload: z.ZodType<TPayload>;
  /** Total claims allowed, including the first. `1` means "never retry". */
  readonly maxAttempts: number;
  readonly backoff: BackoffPolicy;
};

export function defineJob<TType extends string, TSchema extends z.ZodType>(
  type: TType,
  payload: TSchema,
  options: { maxAttempts?: number; backoff?: Partial<BackoffPolicy> } = {},
): JobDefinition<TType, z.output<TSchema>> {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(type)) {
    throw new Error(`Job type "${type}" must be lowercase dot/dash separated (e.g. "repo.fetch").`);
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Job type "${type}" needs maxAttempts >= 1.`);
  }
  return {
    type,
    payload: payload as z.ZodType<z.output<TSchema>>,
    maxAttempts,
    backoff: { ...DEFAULT_BACKOFF, ...options.backoff },
  };
}

/** Delay before the next claim after `attempt` (1-based) failed. */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
}

/** What a handler receives for one claimed attempt. */
export type JobContext<TPayload> = {
  id: string;
  type: string;
  payload: TPayload;
  /** 1-based attempt number of this claim. */
  attempt: number;
  maxAttempts: number;
  /**
   * Aborted when the runner is shutting down and the drain deadline passed.
   * Long handlers must check it and stop; the row stays `running` and is
   * recovered as stale on the next boot.
   */
  signal: AbortSignal;
};

export type JobHandler<TPayload> = (context: JobContext<TPayload>) => Promise<void>;

/** A definition bound to its handler, ready to register with the runner. */
export type RegisteredJob = {
  definition: JobDefinition<string, unknown>;
  handler: JobHandler<unknown>;
};

export function handleJob<TType extends string, TPayload>(
  definition: JobDefinition<TType, TPayload>,
  handler: JobHandler<TPayload>,
): RegisteredJob {
  return {
    definition: definition as JobDefinition<string, unknown>,
    handler: handler as JobHandler<unknown>,
  };
}

/**
 * A payload that can never succeed (it fails validation, or the handler knows
 * retrying is pointless). Thrown from a handler, it fails the job immediately
 * regardless of remaining attempts.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}
