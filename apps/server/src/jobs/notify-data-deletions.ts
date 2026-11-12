import {
  listUnnotifiedDataDeletions,
  markDataDeletionNotified,
} from "@cockpit-context/db/data-deletion-notices";
import { defineJob, handleJob, MINUTE } from "@cockpit-context/jobs";
import { isEmailConfigured } from "@cockpit-context/mailer";
import { z } from "zod";
import { sendDataDeletedAlert } from "./operational-alerts.js";

export const notifyDataDeletionsJob = defineJob(
  "database.notify-data-deletions",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

export const NOTIFY_DATA_DELETIONS_SCHEDULE = { everyMs: 15 * MINUTE };

// A periodic slot can overlap a slow previous slot when the runner has spare
// concurrency. Serialize the read/send/mark cycle within this single process.
let pending: Promise<unknown> = Promise.resolve();

/** At least once: never acknowledge a notice unless an admin received it. */
export function notifyDataDeletions(
  signal: AbortSignal,
): Promise<{ notified: number; retried: number }> {
  const run = pending.then(async () => {
    if (signal.aborted || !isEmailConfigured()) return { notified: 0, retried: 0 };
    const notices = await listUnnotifiedDataDeletions();
    let notified = 0;
    let retried = 0;
    for (const notice of notices) {
      if (signal.aborted) break;
      // Counts and migration identifiers only; database notes and backup labels
      // stay out of process logs and readiness responses.
      console.warn(`[notify-data-deletions] Scheduled deletion ${notice.name} completed.`);
      try {
        const delivered = await sendDataDeletedAlert(notice);
        if (delivered === 0) {
          retried++;
          continue;
        }
        await markDataDeletionNotified(notice.name);
        notified++;
      } catch {
        retried++;
        console.error("[notify-data-deletions] Delivery or recording failed; retrying next run.");
      }
    }
    return { notified, retried };
  });
  pending = run.catch(() => undefined);
  return run;
}

export const notifyDataDeletionsHandler = handleJob(notifyDataDeletionsJob, async ({ signal }) => {
  await notifyDataDeletions(signal);
});
