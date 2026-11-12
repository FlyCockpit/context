import { defineJob } from "@cockpit-context/jobs";
import { z } from "zod";

/**
 * Run-engine job types. Definitions only (docs/development.md): producers import
 * these; the handler lives in apps/server/src/jobs/run-jobs.ts.
 */

const id = z.string().min(1).max(64);

/**
 * Write a checkout's model-written overview (docs/product.md). Enqueued after the summary was moved to PENDING
 * (`requestCheckoutSummary`); the handler skips anything no longer PENDING,
 * so an edit made in the meantime is never overwritten. Single attempt: it
 * spends model tokens, and the next run that reads the checkout asks again.
 */
export const summarizeCheckoutJob = defineJob(
  "checkout.summarize",
  z.object({
    checkoutId: id,
    ownerId: id,
    packageId: id.optional(),
    force: z.boolean().optional(),
  }),
  { maxAttempts: 1 },
);
