import {
  generateCheckoutSummary,
  generateRepoMap,
  LspManager,
  type LspStatus,
  runExploreAgent,
} from "@cockpit-context/explore";
import { enqueueJob } from "@cockpit-context/jobs";
import {
  cachedResolveTarget,
  ensureRepository,
  materializeCheckout,
  onCheckoutRemoval,
} from "@cockpit-context/repos";
import { pruneStorageJob } from "@cockpit-context/repos/jobs";

import { loadRunConfig } from "./config";
import { createRunEngine, type RunEngine, type SummaryFailure } from "./engine";
import { summarizeCheckoutJob } from "./job-definitions";
import { prismaRunStore } from "./store";

let engine: RunEngine | undefined;
let lspManager: LspManager | undefined;

export type SummaryFailureListener = (failure: SummaryFailure) => void | Promise<void>;

const summaryFailureListeners = new Set<SummaryFailureListener>();

/**
 * Hear about summary runs that ended `failed`. The `checkout.summarize` job
 * succeeds once it has started the run, so the server registers its
 * operational alert here instead of on the job. Returns the unregister function.
 */
export function onSummaryFailure(listener: SummaryFailureListener): () => void {
  summaryFailureListeners.add(listener);
  return () => {
    summaryFailureListeners.delete(listener);
  };
}

async function notifySummaryFailure(failure: SummaryFailure): Promise<void> {
  await Promise.all(
    [...summaryFailureListeners].map(async (listener) => {
      try {
        await listener(failure);
      } catch (error) {
        console.error("[runs] summary failure listener failed", error);
      }
    }),
  );
}

/**
 * The process-wide run engine, created on first use: env config, the Prisma
 * store, the real git layer and explore agent, the job table, and one
 * language-server pool (sandboxed per COCKPIT_CONTEXT_LSP_SANDBOX) whose servers are
 * stopped before any checkout's worktree is removed (prune, delete).
 */
export function getRunEngine(): RunEngine {
  if (engine) return engine;
  const config = loadRunConfig();
  const lsp = new LspManager({
    maxServers: config.lspMaxServers,
    idleMs: config.lspIdleMs,
    sandbox: config.lspSandbox,
  });
  // Start the Landlock sandbox probe now (the engine is created at boot), so an
  // unusable sandbox is logged at startup rather than on the first
  // investigation. Not awaited: the probe is asynchronous and never blocks
  // boot; the LSP tools stay off (fail closed) until it passes, and a
  // transient failure is probed again on a backoff (packages/explore sandbox.ts).
  void lsp.ready();
  lspManager = lsp;
  onCheckoutRemoval(async (checkoutIds) => {
    await Promise.all(checkoutIds.map((checkoutId) => lsp.stopCheckout(checkoutId)));
  });
  engine = createRunEngine({
    store: prismaRunStore,
    config,
    // Exact-version resolutions are memoized (COCKPIT_CONTEXT_VERSION_CACHE_*,
    // packages/repos/src/resolution-cache.ts); branches always resolve afresh.
    repos: { resolveTarget: cachedResolveTarget, ensureRepository, materializeCheckout },
    explore: { run: runExploreAgent, summarize: generateCheckoutSummary, repoMap: generateRepoMap },
    lsp,
    onSummaryFailed: notifySummaryFailure,
    jobs: {
      async enqueueSummary(request) {
        await enqueueJob(summarizeCheckoutJob, request);
      },
      async enqueuePrune() {
        await enqueueJob(pruneStorageJob, { reason: "checkout-created", measure: false });
      },
    },
  });
  return engine;
}

/**
 * Whether the LSP tools are offered and why not (COCKPIT_CONTEXT_LSP_MAX_SERVERS,
 * COCKPIT_CONTEXT_LSP_SANDBOX): the admin runtime-config screen shows it.
 */
export function getLspStatus(): LspStatus {
  getRunEngine();
  if (!lspManager) throw new Error("getRunEngine() did not create the LSP pool");
  return lspManager.status();
}
