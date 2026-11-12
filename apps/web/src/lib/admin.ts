import type { AppRouterClient } from "@cockpit-context/api/routers/index";

import type { PillTone } from "@/components/status-pill";

/**
 * Display helpers for the admin Storage, Jobs and Settings pages
 * (docs/product.md). Pure, so they are unit-tested without React.
 */

type Client = AppRouterClient;
type StoragePage = Awaited<ReturnType<Client["adminStorage"]["list"]>>;
export type StorageRepository = StoragePage["items"][number];
export type StorageCheckout = StorageRepository["checkouts"][number];
export type AdminJob = Awaited<ReturnType<Client["adminJobs"]["list"]>>["items"][number];
export type AdminJobStatus = AdminJob["status"];
export type RuntimeConfig = Awaited<ReturnType<Client["settings"]["runtimeConfig"]>>;

/** Automatic pruning evicts down to this share of the cap (packages/repos/src/prune.ts). */
const PRUNE_TARGET_FRACTION = 0.9;

export type StorageLevel = "ok" | "near" | "over";

/** Used storage against the cap: `near` from the prune target, `over` past the cap. */
export function storageLevel(totalBytes: number, capBytes: number): StorageLevel {
  if (capBytes <= 0) return totalBytes > 0 ? "over" : "ok";
  if (totalBytes > capBytes) return "over";
  if (totalBytes >= capBytes * PRUNE_TARGET_FRACTION) return "near";
  return "ok";
}

/** 0..1 share of the cap, clamped (an over-cap total fills the meter). */
export function storageFraction(totalBytes: number, capBytes: number): number {
  if (capBytes <= 0) return totalBytes > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, totalBytes / capBytes));
}

export const STORAGE_LEVEL_TONE: Record<StorageLevel, PillTone> = {
  ok: "good",
  near: "busy",
  over: "bad",
};

export const REPOSITORY_STATUS_TONE: Record<StorageRepository["status"], PillTone> = {
  pending: "muted",
  cloning: "busy",
  ready: "good",
  failed: "bad",
};

export const CHECKOUT_STATUS_TONE: Record<StorageCheckout["status"], PillTone> = {
  pending: "busy",
  ready: "good",
  failed: "bad",
};

export const JOB_STATUS_TONE: Record<AdminJobStatus, PillTone> = {
  queued: "muted",
  running: "busy",
  succeeded: "good",
  failed: "bad",
};

/** The filter values of the Jobs page, `all` first (no `status` input). */
export const JOB_FILTERS = ["all", "failed", "running", "queued", "succeeded"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export function jobStatusInput(filter: JobFilter): AdminJobStatus | undefined {
  return filter === "all" ? undefined : filter;
}

/** A repository counts as in use when any checkout it lists holds an unexpired lease. */
export function repositoryLeased(repository: Pick<StorageRepository, "checkouts">): boolean {
  return repository.checkouts.some((checkout) => checkout.leased);
}

/**
 * The time a job row shows beside its status: when it finished, when it was
 * claimed (running), or when it may next run (queued, including a retry's
 * backoff).
 */
export function jobTimestamp(job: Pick<AdminJob, "status" | "finishedAt" | "lockedAt" | "runAt">): {
  kind: "finished" | "started" | "runs";
  at: Date | string | null;
} {
  if (job.status === "succeeded" || job.status === "failed") {
    return { kind: "finished", at: job.finishedAt };
  }
  if (job.status === "running") return { kind: "started", at: job.lockedAt };
  return { kind: "runs", at: job.runAt };
}

/**
 * `600` → `10 minutes` in the active locale: the largest of hours, minutes or
 * seconds that divides the value exactly, so a limit reads as configured.
 */
export function formatSeconds(seconds: number, locale: string): string {
  const [unit, size] =
    seconds > 0 && seconds % 3600 === 0
      ? (["hour", 3600] as const)
      : seconds > 0 && seconds % 60 === 0
        ? (["minute", 60] as const)
        : (["second", 1] as const);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(seconds / size);
}
