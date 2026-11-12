import { defineJob } from "@cockpit-context/jobs";
import { z } from "zod";

/**
 * Git-layer background job types. Definitions only (docs/development.md): the
 * routers and the run engine import these to enqueue type-checked payloads;
 * the handlers live in apps/server/src/jobs/repository-jobs.ts.
 *
 * Fetching is idempotent, so a crash between the side effect and the success
 * mark just re-runs cheaply. Clones and checkouts are made inline by the run
 * engine (`ensureRepository`, `materializeCheckout`), not by jobs.
 */

const id = z.string().min(1).max(64);

/** Fetch a repository's branches (`default`) or all tags (`tags`). */
export const fetchRepositoryJob = defineJob(
  "repository.fetch",
  z.object({ repositoryId: id, mode: z.enum(["default", "tags"]).default("default") }),
  { maxAttempts: 3, backoff: { baseMs: 30_000, maxMs: 10 * 60_000 } },
);

/**
 * Storage accounting and LRU eviction (`pruneStorage`). Hourly with
 * `measure: true`, and after every new checkout without re-measuring (the
 * checkout was just measured). Single attempt: the next trigger is the retry.
 */
export const pruneStorageJob = defineJob(
  "storage.prune",
  z.object({
    reason: z.enum(["schedule", "checkout-created", "manual"]),
    measure: z.boolean().default(false),
  }),
  { maxAttempts: 1 },
);
