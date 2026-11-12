import prisma, { type Prisma } from "@cockpit-context/db";
import { retryFailedJob } from "@cockpit-context/jobs";
import { z } from "zod";

import { adminOr404Procedure } from "../index";
import { reasonError } from "../lib/domain-errors";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId, shortText } from "../lib/schemas";

/**
 * The background job table (docs/product.md), replacing the
 * BullMQ queue page. Payloads are not returned: they carry user and entity
 * ids, and the admin page needs the type, state and error only.
 */

const jobSelect = {
  id: true,
  createdAt: true,
  type: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  runAt: true,
  lockedAt: true,
  finishedAt: true,
  lastError: true,
} satisfies Prisma.BackgroundJobSelect;

type JobRow = Prisma.BackgroundJobGetPayload<{ select: typeof jobSelect }>;

function serializeJob(row: JobRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt,
    lockedAt: row.lockedAt,
    finishedAt: row.finishedAt,
    /** Operator detail (may quote git or provider output); show in a code block. */
    lastError: row.lastError,
  };
}

export const adminJobsRouter = {
  list: adminOr404Procedure
    .input(
      cursorPageInput.extend({
        status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
        type: shortText.optional(),
      }),
    )
    .handler(async ({ input }) => {
      const where: Prisma.BackgroundJobWhereInput = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.type ? { type: input.type } : {}),
      };
      const rows = await prisma.backgroundJob.findMany({
        where: withCursor(where, "createdAt", input.cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(input.limit),
        select: jobSelect,
      });
      const page = cursorPage(rows, input.limit, "createdAt");
      return { items: page.items.map(serializeJob), nextCursor: page.nextCursor };
    }),

  /** Put a failed job back in the queue with a fresh attempt budget. */
  retry: adminOr404Procedure.input(z.object({ id: entityId })).handler(async ({ input }) => {
    const { retried, missing } = await retryFailedJob(input.id);
    if (missing) throw reasonError("NOT_FOUND", "JOB_NOT_FOUND", "Job not found.");
    if (!retried) {
      throw reasonError("CONFLICT", "JOB_NOT_FAILED", "Only failed jobs can be retried.");
    }
    return { ok: true as const };
  }),
};
