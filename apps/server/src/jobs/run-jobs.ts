import { handleJob } from "@cockpit-context/jobs";
import { getRunEngine } from "@cockpit-context/runs";
import { summarizeCheckoutJob } from "@cockpit-context/runs/jobs";

/**
 * `checkout.summarize`: starts one explore run with the overview prompt
 * (docs/product.md) and succeeds as soon as
 * the run is started or skipped. It never waits for the run, so a summary
 * queued behind the global cap holds no job-runner slot. The engine skips a
 * summary that is no longer PENDING, records the run's outcome on the checkout,
 * and reports a failed run through `onSummaryFailure` (the operational alert,
 * wired in ./index.ts). Shutdown interrupts the run through the engine.
 */
export const summarizeCheckoutHandler = handleJob(
  summarizeCheckoutJob,
  async ({ payload, signal }) => {
    await getRunEngine().summarizeCheckout(payload, signal);
  },
);
