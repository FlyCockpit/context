import { createHash } from "node:crypto";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { backupMonitorConfigWarnings } from "@cockpit-context/env/backup-config";
import { env } from "@cockpit-context/env/shared";

/** Mirrors scripts/backup/s3.mjs: objects live directly under the chosen prefix. */
export function backupNamespace(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error("BACKUP_S3_PREFIX must not be empty.");
  return normalized;
}

/**
 * Where the last verdict is kept between checks. Satisfied by the Postgres
 * `AppSetting`-backed `appSettingFreshnessStore` (./backup-freshness-store.ts);
 * an expired entry must read back as `null`.
 */
export type FreshnessStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
};

/**
 * Backup freshness — "did a dump land recently?"
 *
 * A backup cron that silently stops running produces no error anywhere. The
 * only signal that covers both "ran and failed" and "never ran" is the age of
 * the newest object in the backup bucket. A background job computes that on a
 * schedule (`backup.check-freshness`), stores the verdict in Postgres, and alerts
 * admins when it is stale; the admin dashboard reads the same record so the
 * problem is visible the next time anyone opens `/admin`.
 *
 * Read-only against the bucket: ListObjectsV2 only, using the monitor's
 * dedicated ListBucket-only key. It never needs dump read/write access.
 */

/**
 * A cached result belongs to exactly one backup location and artifact contract.
 * Rotating credentials does not change this identity; switching the
 * bucket, endpoint, region, or human prefix does, so an old "fresh" result
 * cannot bless a new target before its checker performs a new list.
 */
export function backupFreshnessKey(): string {
  const namespace = backupNamespace(env.BACKUP_S3_PREFIX);
  const config = [
    "plain-dump-v1",
    env.BACKUP_S3_BUCKET ?? "",
    env.BACKUP_S3_REGION,
    env.BACKUP_S3_ENDPOINT ?? "",
    namespace,
  ].join("\n");
  return `backup:freshness:${createHash("sha256").update(config).digest("hex").slice(0, 24)}`;
}

/** Keep the last verdict for three days so a stopped checker reads as "unknown". */
export const BACKUP_FRESHNESS_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Checker schedule interval — a verdict older than this has not been re-checked. */
export const BACKUP_CHECKER_INTERVAL_HOURS = 6;

/**
 * Slack past the interval before a verdict counts as overdue. The checker runs
 * every `BACKUP_CHECKER_INTERVAL_HOURS`, so a verdict is routinely that old just
 * before the next run lands; without slack the status flips to stale around
 * every scheduled run.
 */
const BACKUP_CHECKER_GRACE_HOURS = 1;

/** Valid stored freshness states. */
const FRESHNESS_STATES = new Set([
  "fresh",
  "stale",
  "empty",
  "error",
  "misconfigured",
  "setup-missing",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}

/**
 * Runtime validation for a stored freshness record. Malformed structured JSON
 * must never become `fresh`; callers treat null as unknown/attention.
 */
export function parseBackupFreshness(raw: unknown, now: Date = new Date()): BackupFreshness | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.state !== "string" || !FRESHNESS_STATES.has(value.state)) return null;
  if (!isIsoTimestamp(value.checkedAt)) return null;
  if (Date.parse(value.checkedAt) > now.getTime() + CLOCK_SKEW_TOLERANCE_HOURS * 3_600_000) {
    return null;
  }

  if (!isFiniteNumber(value.maxAgeHours) || value.maxAgeHours < 1 || value.maxAgeHours > 24 * 30) {
    return null;
  }
  const maxAgeHours = value.maxAgeHours;

  switch (value.state) {
    case "fresh":
    case "stale": {
      if (typeof value.latestKey !== "string" || value.latestKey.length === 0) return null;
      if (!isIsoTimestamp(value.latestAt)) return null;
      if (!isFiniteNumber(value.ageHours) || value.ageHours < 0) return null;
      if (value.reason !== undefined && value.reason !== "future-timestamp") return null;
      return {
        state: value.state,
        checkedAt: value.checkedAt,
        latestKey: value.latestKey,
        latestAt: value.latestAt,
        ageHours: value.ageHours,
        maxAgeHours,
        ...(value.reason === "future-timestamp" ? { reason: "future-timestamp" as const } : {}),
      };
    }
    case "empty":
      return { state: "empty", checkedAt: value.checkedAt, maxAgeHours };
    case "error":
      return {
        state: "error",
        checkedAt: value.checkedAt,
        maxAgeHours,
        message: typeof value.message === "string" ? value.message : "unknown error",
      };
    case "misconfigured":
    case "setup-missing":
      return typeof value.reason === "string" && value.reason.length > 0
        ? {
            state: value.state,
            checkedAt: value.checkedAt,
            maxAgeHours,
            reason: value.reason,
          }
        : null;
    default:
      return null;
  }
}

/** Bound the listing so a bucket with years of dumps cannot hang the job. */
const MAX_LIST_PAGES = 50;

/** Clock drift we tolerate before a future-dated backup counts as broken. */
const CLOCK_SKEW_TOLERANCE_HOURS = 5 / 60;

/**
 * Why a verdict is what it is, when the age alone does not say. A code, not a
 * sentence: the admin card translates it, so it must not carry English prose.
 */
export type BackupFreshnessReason = "future-timestamp";

export type BackupFreshness =
  | {
      state: "fresh" | "stale";
      checkedAt: string;
      latestKey: string;
      latestAt: string;
      ageHours: number;
      maxAgeHours: number;
      /** Set only when the verdict needs an explanation the age alone does not give. */
      reason?: BackupFreshnessReason;
    }
  | {
      /**
       * A bucket is set but this freshness monitor cannot list it (see
       * `backupMonitorConfigWarnings`). That leaves backup health unknown, so
       * it must be as loud as a stale backup rather than read as "off". It
       * does not assert whether a separate dump writer can still upload.
       */
      state: "misconfigured";
      checkedAt: string;
      maxAgeHours: number;
      /** The monitor-validation text, shown verbatim to admins — it names the variable to fix. */
      reason: string;
    }
  | {
      /**
       * Logical backups are enabled but the off-site bucket is not configured
       * yet. Distinct from `BACKUP_ENABLED=false` (deliberate opt-out).
       */
      state: "setup-missing";
      checkedAt: string;
      maxAgeHours: number;
      reason: string;
    }
  | {
      state: "empty";
      checkedAt: string;
      maxAgeHours: number;
    }
  | {
      state: "error";
      checkedAt: string;
      maxAgeHours: number;
      message: string;
    };

type BackupBucket = {
  client: S3Client;
  bucket: string;
  prefix: string;
};

/**
 * A backup bucket that is set but not usable for the monitor — a missing or
 * reused monitor key pair, or region "auto" with no endpoint. `packages/env` deliberately does NOT fail
 * validation on these (a backup-only mistake must never crash-loop the server),
 * so the check reports monitor misconfiguration rather than
 * throwing on every run or, worse, reporting a bucket it cannot address.
 * Returns null when the monitor configuration is fine.
 */
export function backupFreshnessMisconfiguration(): string | null {
  return backupMonitorConfigWarnings(env).join(" ") || null;
}

/**
 * True when this deployment intends to take logical backups at all.
 * `BACKUP_ENABLED=false` is deliberate opt-out; a missing bucket with backups
 * enabled still counts as on — the admin card reports setup-missing instead.
 */
export function backupFreshnessEnabled(): boolean {
  return env.BACKUP_ENABLED;
}

/** True when a backup bucket name is configured (credentials may still be wrong). */
export function backupFreshnessBucketConfigured(): boolean {
  return Boolean(env.BACKUP_S3_BUCKET);
}

const SETUP_MISSING_REASON =
  "BACKUP_S3_BUCKET is not set. Logical backups are enabled but the off-site bucket is missing — set BACKUP_S3_BUCKET, then configure dump-writer and freshness-monitor credentials for the processes that need them.";

/**
 * Enabled backups with no bucket yet — first-deploy state on Render and similar.
 * Computed from env, not the stored verdict, because no checker can list a bucket that does
 * not exist.
 */
export function setupMissingBackupFreshness(now: Date = new Date()): BackupFreshness | null {
  if (!env.BACKUP_ENABLED || env.BACKUP_S3_BUCKET) return null;
  return {
    state: "setup-missing",
    checkedAt: now.toISOString(),
    maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
    reason: SETUP_MISSING_REASON,
  };
}

/**
 * The verdict for a set-but-unusable backup config, or null when the config is
 * fine (or absent). Computed from env, not the stored verdict: the checker never gets to
 * run the check in this state, so the admin card would otherwise show nothing.
 */
export function misconfiguredBackupFreshness(now: Date = new Date()): BackupFreshness | null {
  const reason = backupFreshnessMisconfiguration();
  if (!reason) return null;
  return {
    state: "misconfigured",
    checkedAt: now.toISOString(),
    maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
    reason,
  };
}

let loggedMisconfiguration = false;

/**
 * True when the freshness check can actually list the bucket. A misconfigured
 * bucket cannot, so the listing is skipped — but the misconfiguration is
 * reported (`misconfiguredBackupFreshness`), never swallowed.
 */
export function backupFreshnessConfigured(): boolean {
  if (!backupFreshnessBucketConfigured()) return false;
  const misconfigured = backupFreshnessMisconfiguration();
  if (!misconfigured) return true;
  if (!loggedMisconfiguration) {
    loggedMisconfiguration = true;
    console.warn(
      `[backup-freshness] BACKUP_S3_BUCKET is set but this monitor cannot list it, ` +
        `so no fresh backup verdict will be recorded. ${misconfigured}`,
    );
  }
  return false;
}

function buildBackupBucket(): BackupBucket | null {
  if (!backupFreshnessConfigured()) return null;
  if (
    !env.BACKUP_S3_BUCKET ||
    !env.BACKUP_MONITOR_S3_ACCESS_KEY_ID ||
    !env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  const client = new S3Client({
    region: env.BACKUP_S3_REGION,
    endpoint: env.BACKUP_S3_ENDPOINT,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.BACKUP_MONITOR_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY,
    },
  });
  return {
    client,
    bucket: env.BACKUP_S3_BUCKET,
    prefix: backupNamespace(env.BACKUP_S3_PREFIX),
  };
}

let cachedBucket: BackupBucket | null | undefined;
function backupBucket(): BackupBucket | null {
  cachedBucket ??= buildBackupBucket();
  return cachedBucket;
}

export type LatestBackup = { key: string; lastModified: Date } | null;

/**
 * Newest completed manual/pre-migrate/pre-drop/daily dump directly under the prefix.
 * Pre-restore snapshots and nested keys do not prove a working backup writer.
 * Pages through the listing (bounded) because S3 returns keys in lexical
 * order, not by date, and lifecycle rules may leave hundreds behind.
 */
export async function findLatestBackup(
  bucket: BackupBucket = requireBackupBucket(),
): Promise<LatestBackup> {
  let latest: LatestBackup = null;
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await bucket.client.send(
      new ListObjectsV2Command({
        Bucket: bucket.bucket,
        Prefix: `${bucket.prefix}/`,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of result.Contents ?? []) {
      if (!object.Key?.startsWith(`${bucket.prefix}/`) || !object.LastModified) continue;
      const name = object.Key.slice(bucket.prefix.length + 1);
      if (!/^(?:manual|pre-migrate|pre-drop|daily)-\d{8}T\d{6}Z(?:-\d+)*\.dump$/.test(name)) {
        continue;
      }
      if (!Number.isFinite(object.LastModified.getTime()) || (object.Size ?? 1) <= 0) continue;
      if (!latest || object.LastModified > latest.lastModified) {
        latest = { key: object.Key, lastModified: object.LastModified };
      }
    }
    if (!result.IsTruncated) return latest;
    if (!result.NextContinuationToken)
      throw new Error("Backup listing returned no continuation token.");
    continuationToken = result.NextContinuationToken;
  }
  throw new Error("Backup listing exceeded its page limit.");
}

function requireBackupBucket(): BackupBucket {
  const bucket = backupBucket();
  if (!bucket) {
    throw new Error(
      "Backup freshness check requires BACKUP_S3_BUCKET and dedicated BACKUP_MONITOR_S3_* credentials.",
    );
  }
  return bucket;
}

/** Pure: turn a listing result into a verdict. */
export function evaluateBackupFreshness(
  latest: LatestBackup,
  now: Date,
  maxAgeHours: number = env.BACKUP_MAX_AGE_HOURS,
): BackupFreshness {
  const checkedAt = now.toISOString();
  if (!latest) return { state: "empty", checkedAt, maxAgeHours };
  const ageHours = (now.getTime() - latest.lastModified.getTime()) / 3_600_000;
  // A backup dated in the future can never age past the limit, so clamping the
  // age to 0 would report "fresh" forever — the exact failure this check
  // exists to catch. A few minutes either way is ordinary clock drift between
  // the bucket and this process; anything beyond that is a real problem
  // (a wrong clock, or an object written with a bogus timestamp) and the
  // freshness verdict cannot be trusted until it is fixed.
  const future = ageHours < -CLOCK_SKEW_TOLERANCE_HOURS;
  return {
    state: future || ageHours > maxAgeHours ? "stale" : "fresh",
    checkedAt,
    latestKey: latest.key,
    latestAt: latest.lastModified.toISOString(),
    ageHours: Math.round(Math.max(0, ageHours) * 10) / 10,
    maxAgeHours,
    ...(future ? { reason: "future-timestamp" as const } : {}),
  };
}

/** List the bucket and evaluate; listing errors become an `error` verdict. */
export async function checkBackupFreshness(now: Date = new Date()): Promise<BackupFreshness> {
  const setupMissing = setupMissingBackupFreshness(now);
  if (setupMissing) return setupMissing;
  // A bucket that cannot be addressed produces a misconfiguration verdict, not
  // a listing error: the fix is an env var, and saying so beats "AccessDenied".
  const misconfigured = misconfiguredBackupFreshness(now);
  if (misconfigured) return misconfigured;
  try {
    const latest = await findLatestBackup();
    return evaluateBackupFreshness(latest, now);
  } catch (err) {
    return {
      state: "error",
      checkedAt: now.toISOString(),
      maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
      // Network errors can embed endpoint credentials or URL tokens.
      message:
        err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(err.name) && err.name !== "Error"
          ? err.name
          : "Backup bucket listing failed. Check monitor credentials and connectivity.",
    };
  }
}

/** A verdict that admins need to act on. */
export function backupFreshnessNeedsAttention(status: BackupFreshness): boolean {
  return status.state !== "fresh";
}

export async function writeBackupFreshness(
  store: FreshnessStore,
  status: BackupFreshness,
): Promise<void> {
  await store.set(backupFreshnessKey(), JSON.stringify(status), BACKUP_FRESHNESS_TTL_SECONDS);
}

/**
 * Recompute time-dependent fields on a cached verdict. Freshness ages with
 * wall-clock time; a checker that has not run within its interval cannot leave a
 * dump reading as healthy.
 */
export function refreshBackupFreshness(
  status: BackupFreshness,
  now: Date = new Date(),
): BackupFreshness | null {
  const checkedAtMs = Date.parse(status.checkedAt);
  if (Number.isNaN(checkedAtMs)) return null;

  const checkerAgeHours = (now.getTime() - checkedAtMs) / 3_600_000;
  const checkerOverdue =
    checkerAgeHours > BACKUP_CHECKER_INTERVAL_HOURS + BACKUP_CHECKER_GRACE_HOURS;

  if (status.state === "fresh" || status.state === "stale") {
    const latestAtMs = Date.parse(status.latestAt);
    if (Number.isNaN(latestAtMs)) return null;
    const ageHours = (now.getTime() - latestAtMs) / 3_600_000;
    const future = ageHours < -CLOCK_SKEW_TOLERANCE_HOURS;
    const maxAgeHours = env.BACKUP_MAX_AGE_HOURS;
    const staleByAge = future || ageHours > maxAgeHours;
    const state = staleByAge || checkerOverdue ? "stale" : "fresh";
    // `reason` is recomputed below: a cached "future-timestamp" must not
    // survive once the dump's timestamp is no longer in the future.
    const { reason: _cachedReason, ...rest } = status;
    return {
      ...rest,
      state,
      maxAgeHours,
      ageHours: Math.round(Math.max(0, ageHours) * 10) / 10,
      ...(future ? { reason: "future-timestamp" as const } : {}),
    };
  }

  if (status.state === "empty" || status.state === "error") {
    if (checkerAgeHours > BACKUP_FRESHNESS_TTL_SECONDS / 3_600_000) return null;
    return status;
  }

  return status;
}

/**
 * Last verdict, or null when none was recorded within the TTL (the check has
 * not run yet, or the job runner is down). Callers should treat null as "unknown",
 * not "fine", when backups are configured.
 */
export async function readBackupFreshness(
  store: FreshnessStore,
  now: Date = new Date(),
): Promise<BackupFreshness | null> {
  const setupMissing = setupMissingBackupFreshness(now);
  if (setupMissing) return setupMissing;

  const raw = await store.get(backupFreshnessKey());
  if (!raw) return null;
  try {
    const parsed = parseBackupFreshness(JSON.parse(raw), now);
    if (!parsed) return null;
    return refreshBackupFreshness(parsed, now);
  } catch {
    return null;
  }
}
