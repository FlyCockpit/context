import { sweepStaleSnapshotSyncs } from "@cockpit-context/api/lib/snapshot-tasks";
import { defineJob, handleJob, MINUTE } from "@cockpit-context/jobs";
import { getRunEngine } from "@cockpit-context/runs";
import { z } from "zod";

/**
 * The stale-work sweep (docs/deploy.md § Home server behind a Cloudflare
 * Tunnel): long web actions run in the background, owned by this process,
 * with their state in Postgres. Boot recovery closes what a dead process left;
 * this closes, without waiting for a restart, anything still marked active
 * that no live task of this process owns (a row whose own final write failed):
 *
 * - agent runs still queued/running (a web conversation's `resolving` run
 *   included) → interrupted, after a grace period that covers a run being
 *   registered right now;
 * - snapshot clones/refreshes still RUNNING → FAILED / SNAPSHOT_INTERRUPTED.
 *
 * Single attempt: both writes are idempotent and state-predicated, and the
 * next slot is the retry.
 */
export const sweepStaleWorkJob = defineJob(
  "work.sweep-stale",
  z.object({ reason: z.enum(["schedule"]) }),
  { maxAttempts: 1 },
);

/** Every 5 minutes, off the round minutes. */
export const SWEEP_STALE_WORK_SCHEDULE = { everyMs: 5 * MINUTE, offsetMs: 2 * MINUTE + 17_000 };

/** How old an active row must be before the sweep may close it. */
const STALE_WORK_GRACE_MS = 5 * MINUTE;

export const sweepStaleWorkHandler = handleJob(sweepStaleWorkJob, async ({ id, payload }) => {
  const runs = await getRunEngine().sweepStaleRuns(STALE_WORK_GRACE_MS);
  const snapshots = await sweepStaleSnapshotSyncs(STALE_WORK_GRACE_MS);
  if (runs + snapshots > 0) {
    console.warn(
      `[work.sweep-stale] Job ${id} (${payload.reason}) closed ${runs} stale run(s) and ` +
        `${snapshots} stale snapshot sync(s).`,
    );
  }
});
