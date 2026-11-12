import { randomUUID } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-context/db";
import { z } from "zod";
import type { JobDefinition } from "./define";
import { jobWakeups } from "./wakeups";

/** Longest `lastError` kept on a row; stack traces and provider bodies get cut. */
export const MAX_ERROR_LENGTH = 2_000;

export type EnqueueOptions = {
  /** Earliest claim time. Defaults to now. */
  runAt?: Date;
  /** Overrides the definition's `maxAttempts` for this row. */
  maxAttempts?: number;
  /**
   * Idempotency key: a second enqueue with the same key returns the existing
   * row (whatever its status) instead of inserting. Unique across all types.
   */
  dedupeKey?: string;
  /**
   * Transaction client, so a producer can enqueue atomically with its own
   * writes. The in-process wakeup fires immediately; if the transaction has
   * not committed yet the runner simply finds the row on its next poll.
   */
  db?: Prisma.TransactionClient;
};

/**
 * Insert a `queued` job. The payload is validated against the definition's
 * schema here, at the producer, so a malformed payload fails the request that
 * built it instead of a background attempt later.
 */
export async function enqueueJob<TPayload>(
  definition: JobDefinition<string, TPayload>,
  payload: TPayload,
  options: EnqueueOptions = {},
): Promise<{ id: string; created: boolean }> {
  const db = options.db ?? prisma;
  const parsed = definition.payload.parse(payload);
  const maxAttempts = options.maxAttempts ?? definition.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be an integer >= 1 (got ${maxAttempts}).`);
  }
  const data = {
    type: definition.type,
    payload: toJsonPayload(parsed),
    runAt: options.runAt ?? new Date(),
    maxAttempts,
    dedupeKey: options.dedupeKey ?? null,
  } satisfies Prisma.BackgroundJobCreateManyInput;

  let result: { id: string; created: boolean };
  if (options.dedupeKey) {
    // `skipDuplicates` is ON CONFLICT DO NOTHING: two racing enqueues with one
    // key insert exactly one row, and neither throws.
    const inserted = await db.backgroundJob.createManyAndReturn({
      data: [data],
      skipDuplicates: true,
      select: { id: true },
    });
    const row = inserted[0];
    if (row) {
      result = { id: row.id, created: true };
    } else {
      const existing = await db.backgroundJob.findUniqueOrThrow({
        where: { dedupeKey: options.dedupeKey },
        select: { id: true },
      });
      result = { id: existing.id, created: false };
    }
  } else {
    const row = await db.backgroundJob.create({ data, select: { id: true } });
    result = { id: row.id, created: true };
  }
  if (result.created) jobWakeups.publish("enqueued", { type: definition.type });
  return result;
}

function toJsonPayload(value: unknown): Prisma.InputJsonValue {
  // Round-trip through JSON so Dates, undefined fields and class instances are
  // normalized exactly as Postgres will store them, and anything that cannot be
  // stored (a BigInt, a cycle) fails at enqueue time.
  const json: unknown = JSON.parse(JSON.stringify(value ?? null));
  return jsonValueSchema.parse(json);
}

const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([jsonValueSchema, z.null()])),
    z.record(z.string(), z.union([jsonValueSchema, z.null()])),
  ]),
);

// ---------------------------------------------------------------------------
// Runner-side operations. Only packages/jobs/src/runner.ts calls these.
// ---------------------------------------------------------------------------

const claimedRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  claimToken: z.string(),
});
export type ClaimedJob = z.infer<typeof claimedRowSchema>;

/**
 * Claim up to `limit` due jobs of the given types for `workerId`.
 *
 * Raw SQL because Prisma has no `FOR UPDATE SKIP LOCKED`. Audited:
 *   - every value is a bound parameter of the tagged template (no string
 *     interpolation into SQL, so no injection surface);
 *   - the inner SELECT is bounded by `LIMIT`, ordered by the
 *     `(status, runAt)` index;
 *   - `SKIP LOCKED` makes concurrent claimers (two loops in one process, or an
 *     accidental second replica) pick disjoint rows instead of blocking or
 *     double-claiming;
 *   - `attempts` is incremented in the same statement, so a crash after the
 *     claim still spends the attempt;
 *   - the RETURNING row is validated with zod, never cast.
 */
export async function claimJobs(
  workerId: string,
  types: readonly string[],
  limit: number,
  executingIds: readonly string[] = [],
): Promise<ClaimedJob[]> {
  if (limit < 1 || types.length === 0) return [];
  // A fresh token per claim statement fences every attempt, including when
  // the same worker retries a row or an admin resets its attempts counter.
  const claimToken = `${workerId}:${randomUUID()}`;
  const rows: unknown = await prisma.$queryRaw`
    UPDATE "background_job"
    SET "status" = 'running',
        "lockedAt" = now(),
        "lockedBy" = ${claimToken},
        "attempts" = "attempts" + 1,
        "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "background_job"
      WHERE "status" = 'queued'
        AND NOT ("id" = ANY(${[...executingIds]}::text[]))
        AND "runAt" <= now()
        AND "type" = ANY(${[...types]}::text[])
      ORDER BY "runAt" ASC, "id" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "attempts", "maxAttempts", "lockedBy" AS "claimToken"
  `;
  return z.array(claimedRowSchema).parse(rows);
}

/** Ownership guard shared by every runner write: never touch a row another claim owns. */
function owned(id: string, claimToken: string) {
  return { id, status: "running", lockedBy: claimToken } satisfies Prisma.BackgroundJobWhereInput;
}

export async function markSucceeded(id: string, claimToken: string): Promise<boolean> {
  const { count } = await prisma.backgroundJob.updateMany({
    where: owned(id, claimToken),
    data: {
      status: "succeeded",
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  return count === 1;
}

export async function markRetry(
  id: string,
  claimToken: string,
  error: string,
  runAt: Date,
): Promise<boolean> {
  const { count } = await prisma.backgroundJob.updateMany({
    where: owned(id, claimToken),
    data: {
      status: "queued",
      runAt,
      lockedAt: null,
      lockedBy: null,
      lastError: truncateError(error),
    },
  });
  return count === 1;
}

export async function markFailed(id: string, claimToken: string, error: string): Promise<boolean> {
  const { count } = await prisma.backgroundJob.updateMany({
    where: owned(id, claimToken),
    data: {
      status: "failed",
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: truncateError(error),
    },
  });
  return count === 1;
}

/** Return unstarted work to the queue only while this claim still owns it. */
export async function releaseClaim(job: ClaimedJob): Promise<void> {
  await prisma.backgroundJob.updateMany({
    where: owned(job.id, job.claimToken),
    data: { status: "queued", lockedAt: null, lockedBy: null, attempts: { decrement: 1 } },
  });
}

/** Refresh each exact attempt; return ids whose ownership was lost. */
export async function refreshLocks(
  claims: readonly { id: string; claimToken: string }[],
): Promise<string[]> {
  if (claims.length === 0) return [];
  const refreshed = await prisma.backgroundJob.updateManyAndReturn({
    where: { OR: claims.map((claim) => owned(claim.id, claim.claimToken)) },
    data: { lockedAt: new Date() },
    select: { id: true },
  });
  const ids = new Set(refreshed.map((row) => row.id));
  return claims.filter((claim) => !ids.has(claim.id)).map((claim) => claim.id);
}

const STALE_ERROR = "Lock expired: the process running this job stopped before it finished.";

const recoveredFailedJobSelect = {
  id: true,
  type: true,
  attempts: true,
  lastError: true,
} satisfies Prisma.BackgroundJobSelect;

/** A stale row failed by recovery because it had no attempts left. */
type RecoveredFailedJob = Prisma.BackgroundJobGetPayload<{
  select: typeof recoveredFailedJobSelect;
}>;

/**
 * Return `running` rows whose lock is older than `staleBefore` to the queue
 * (or fail them when they have no attempts left). Runs on boot — after a
 * crash or a drain timeout every `running` row is orphaned — and periodically
 * for locks that stopped refreshing.
 *
 * Two bounded set-based updates rather than per-row work: the attempt was
 * already counted at claim time, so the only decision is "attempts left or
 * not". The failed rows come back (`failedJobs`) so the runner can report each
 * as a terminal failure, exactly like a handler that ran out of attempts.
 */
export async function recoverStaleJobs(
  staleBefore: Date,
  executingIds: readonly string[] = [],
): Promise<{ requeued: number; failed: number; failedJobs: RecoveredFailedJob[] }> {
  const stale = {
    id: { notIn: [...executingIds] },
    status: "running",
    OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }],
  } satisfies Prisma.BackgroundJobWhereInput;
  const now = new Date();
  // Exhausted rows first, so the requeue below never resurrects them. The
  // attempt was already counted at claim time; a field reference compares the
  // two columns without raw SQL.
  const failedJobs = await prisma.backgroundJob.updateManyAndReturn({
    where: { ...stale, attempts: { gte: prisma.backgroundJob.fields.maxAttempts } },
    data: {
      status: "failed",
      finishedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: STALE_ERROR,
    },
    select: recoveredFailedJobSelect,
  });
  const failed = failedJobs.length;
  const { count: requeued } = await prisma.backgroundJob.updateMany({
    where: stale,
    data: {
      status: "queued",
      runAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: STALE_ERROR,
    },
  });
  return { requeued, failed, failedJobs };
}

const PRUNE_PAGE_SIZE = 1_000;
const PRUNE_MAX_PAGES = 100;

/**
 * Delete finished rows older than the retention windows, in bounded id pages
 * (never one unbounded DELETE). Queued and running rows are never touched.
 */
export async function pruneFinishedJobs(retention: {
  succeededOlderThan: Date;
  failedOlderThan: Date;
}): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const [status, before] of [
    ["succeeded", retention.succeededOlderThan],
    ["failed", retention.failedOlderThan],
  ] as const) {
    for (let page = 0; page < PRUNE_MAX_PAGES; page++) {
      const rows = await prisma.backgroundJob.findMany({
        where: { status, finishedAt: { lt: before } },
        select: { id: true },
        orderBy: { finishedAt: "asc" },
        take: PRUNE_PAGE_SIZE,
      });
      if (rows.length === 0) break;
      const { count } = await prisma.backgroundJob.deleteMany({
        where: { id: { in: rows.map((row) => row.id) }, status },
      });
      deleted += count;
      if (rows.length < PRUNE_PAGE_SIZE) break;
    }
  }
  return { deleted };
}

/**
 * Admin "retry" (`adminJobs.retry`): put one `failed` row back in the queue
 * with a fresh attempt budget and wake the runner. Only failed rows move —
 * a queued, running or succeeded row is left alone and `false` comes back —
 * and `lastError` is kept until the next attempt overwrites it. `missing`
 * says no row has that id (so the caller can answer NOT_FOUND).
 */
export async function retryFailedJob(
  id: string,
): Promise<{ retried: boolean; type?: string; missing?: true }> {
  const row = await prisma.backgroundJob.findUnique({
    where: { id },
    select: { id: true, type: true, status: true },
  });
  if (!row) return { retried: false, missing: true };
  if (row.status !== "failed") return { retried: false };
  const { count } = await prisma.backgroundJob.updateMany({
    where: { id, status: "failed" },
    data: {
      status: "queued",
      attempts: 0,
      runAt: new Date(),
      finishedAt: null,
      lockedAt: null,
      lockedBy: null,
    },
  });
  if (count !== 1) return { retried: false };
  jobWakeups.publish("enqueued", { type: row.type });
  return { retried: true, type: row.type };
}

function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}
