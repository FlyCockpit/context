import { handleJob, PermanentJobError } from "@cockpit-context/jobs";
import { fetchRepository, isRepoError, pruneStorage } from "@cockpit-context/repos";
import { fetchRepositoryJob, pruneStorageJob } from "@cockpit-context/repos/jobs";

/**
 * Git-layer job handlers (docs/product.md): fetching a clone and
 * pruning storage. Clones and checkouts are made inline by the run engine, not
 * by jobs. The work is the @cockpit-context/repos service, which is idempotent, so
 * retries and crash recovery just re-run it. Errors a retry can never fix —
 * bad URL, private address, unconfirmed host key, missing row — fail the job
 * at once instead of burning attempts.
 */
async function runGitWork(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isRepoError(error) && error.permanent) {
      throw new PermanentJobError(error.message, { cause: error });
    }
    throw error;
  }
}

export const fetchRepositoryHandler = handleJob(fetchRepositoryJob, ({ payload, signal }) =>
  runGitWork(() => fetchRepository(payload.repositoryId, { mode: payload.mode, signal })),
);

/** Hourly (measuring first) and after each new checkout: evict LRU storage over the cap. */
export const pruneStorageHandler = handleJob(pruneStorageJob, async ({ id, payload, signal }) => {
  const result = await pruneStorage({ measure: payload.measure, signal });
  if (result.evictedCheckouts.length > 0 || result.evictedRepositories.length > 0) {
    console.log(
      `[storage.prune] Job ${id} (${payload.reason}) freed ${result.beforeBytes - result.afterBytes} bytes: ` +
        `${result.evictedCheckouts.length} checkouts, ${result.evictedRepositories.length} clones.`,
    );
  }
});
