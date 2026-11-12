import { z } from "zod";
import { defineJob, handleJob } from "./define";
import { DAY } from "./schedule";
import { pruneFinishedJobs } from "./store";

/** Succeeded rows are only history; keep a week of it for the admin jobs page. */
const SUCCEEDED_JOB_RETENTION_MS = 7 * DAY;
/** Failed rows are evidence; keep them a month so an operator can still look. */
const FAILED_JOB_RETENTION_MS = 30 * DAY;

/**
 * Housekeeping for the job table itself. Single attempt: the delete is
 * idempotent and the next daily slot is the retry.
 */
export const pruneJobsJob = defineJob("jobs.prune", z.object({}).strict(), { maxAttempts: 1 });

export const pruneJobsHandler = handleJob(pruneJobsJob, async () => {
  const now = Date.now();
  const { deleted } = await pruneFinishedJobs({
    succeededOlderThan: new Date(now - SUCCEEDED_JOB_RETENTION_MS),
    failedOlderThan: new Date(now - FAILED_JOB_RETENTION_MS),
  });
  console.log(`[jobs.prune] Deleted ${deleted} finished job row(s).`);
});
