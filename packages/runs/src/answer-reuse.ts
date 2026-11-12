import { createHash } from "node:crypto";

import { env } from "@cockpit-context/env/server";
import { onRepositoryChange } from "@cockpit-context/repos";

import type { RunConfig } from "./config";
import type { StartedConversation } from "./engine";

/**
 * Owner-scoped answer reuse for MCP questions (docs/mcp.md § Answer reuse),
 * in front of the run engine. In process: one app replica (docs/hosting.md).
 *
 * - **In-flight coalescing.** While an investigation for a key is starting or
 *   running, an identical question joins it: the caller gets the same
 *   `query_id` (the run is the owner's, so `get_query_result` works for every
 *   one of their connections) and no new run starts.
 * - **Exact-match cache.** Once that run completes with an answer (and was
 *   never steered), the same question is answered from it until the TTL ends.
 *
 * The key (`answerReuseKey`) holds the owner id, the package id, the
 * repository id, the requested version or ref (the investigation is told it)
 * and the commit SHA it resolved to, a hash of everything else the
 * investigation reads that can change (the package's notes and subdirectory,
 * the overview it is given: the owner's override, else the generated
 * summary), the normalized question and the model/run configuration. A run
 * that ended up on a different commit than the key's (the branch moved
 * between the key's resolution and the engine's) is never stored. It never crosses owners: the owner id is part
 * of the key and every entry also records it.
 *
 * Only fresh standalone questions use this. Follow-ups and steering act on a
 * conversation and never pass through here.
 *
 * Coalescing and failure: followers share the leader's start. If the start
 * fails, followers get the same error, except when the leader's own request
 * was aborted, in which case a follower retries once as a new leader. A
 * follower that gives up only stops its own wait; the run goes on for the
 * others (runs are not tied to a request).
 */

export interface AnswerReuseKeyInput {
  ownerId: string;
  packageId: string;
  repositoryId: string;
  /** What was asked for: `version:<v>`, `ref:<r>` or `default`. */
  requested: string;
  commitSha: string;
  notes: string | null;
  subdirectory: string | null;
  /** The overview the investigation is given (override, else generated summary), or null. */
  overview: string | null;
  question: string;
  /** `answerModelIdentity(config)`. */
  modelIdentity: string;
}

/** Trim and collapse whitespace runs; case and punctuation are kept (they can matter). */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The model and run settings an answer depends on. */
export function answerModelIdentity(
  config: Pick<
    RunConfig,
    "model" | "helperModel" | "modelApi" | "baseUrl" | "maxIterations" | "runTimeoutMs"
  >,
): string {
  return JSON.stringify([
    config.model ?? null,
    config.helperModel ?? null,
    config.modelApi,
    config.baseUrl ?? null,
    config.maxIterations,
    config.runTimeoutMs,
  ]);
}

export function answerReuseKey(input: AnswerReuseKeyInput): string {
  const context = sha256(
    JSON.stringify([input.notes ?? "", input.subdirectory ?? "", input.overview ?? ""]),
  );
  return sha256(
    JSON.stringify([
      input.ownerId,
      input.packageId,
      input.repositoryId,
      input.requested,
      input.commitSha,
      context,
      normalizeQuestion(input.question),
      input.modelIdentity,
    ]),
  );
}

export interface AnswerReuseScope {
  ownerId: string;
  packageId: string;
  repositoryId: string;
  /** The commit the key was built for; a run on another commit is never stored or joined. */
  commitSha: string;
}

/** `requested` of `answerReuseKey`. */
export function requestedTarget(version: string | null, ref: string | null): string {
  if (version) return `version:${version}`;
  if (ref) return `ref:${ref}`;
  return "default";
}

export type ReuseKind = "cache" | "in-flight" | null;

export interface AnswerReuseOptions {
  enabled: () => boolean;
  ttlMs: () => number;
  maxEntries: () => number;
  now?: () => number;
  /**
   * Resolves once the run ended: true when it completed with an answer that
   * may be reused (not steered). Never rejects on purpose; a throw drops it.
   */
  settle: (ownerId: string, runId: string) => Promise<boolean>;
  /** A cached run is still there and completed (not deleted meanwhile). */
  stillValid: (ownerId: string, runId: string) => Promise<boolean>;
}

type Entry = AnswerReuseScope & {
  state: "running" | "done";
  start: Promise<StartedConversation>;
  started: StartedConversation | null;
  leaderSignal: AbortSignal | undefined;
  expiresAt: number;
};

export interface AnswerReuse {
  /**
   * The run answering `key`: a cached or in-flight one, or `start()`'s (the
   * caller becomes the leader). `signal` only bounds this caller's wait.
   */
  acquire(
    key: string,
    scope: AnswerReuseScope,
    start: () => Promise<StartedConversation>,
    signal?: AbortSignal,
  ): Promise<{ started: StartedConversation; reuse: ReuseKind }>;
  invalidateOwner(ownerId: string): void;
  invalidatePackage(packageId: string): void;
  invalidateRepository(repositoryId: string, ownerId?: string): void;
  clear(): void;
  readonly size: number;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createAnswerReuse(options: AnswerReuseOptions): AnswerReuse {
  const entries = new Map<string, Entry>();
  const clock = options.now ?? Date.now;

  function drop(predicate: (entry: Entry) => boolean): void {
    for (const [key, entry] of entries) if (predicate(entry)) entries.delete(key);
  }

  function evict(): void {
    const max = Math.max(1, options.maxEntries());
    while (entries.size > max) {
      // Oldest finished entry first; an in-flight one only when none is left.
      let victim: string | undefined;
      for (const [key, entry] of entries) {
        if (entry.state === "done") {
          victim = key;
          break;
        }
      }
      victim ??= entries.keys().next().value;
      if (victim === undefined) return;
      entries.delete(victim);
    }
  }

  async function watch(key: string, entry: Entry, started: StartedConversation): Promise<void> {
    let reusable = false;
    try {
      reusable = await options.settle(entry.ownerId, started.runId);
    } catch {
      reusable = false;
    }
    // Invalidated (or replaced) meanwhile: never store it.
    if (entries.get(key) !== entry) return;
    if (!reusable || !options.enabled()) {
      entries.delete(key);
      return;
    }
    entry.state = "done";
    entry.expiresAt = clock() + options.ttlMs();
    // Re-insert: recency for the LRU order.
    entries.delete(key);
    entries.set(key, entry);
    evict();
  }

  async function lead(
    key: string,
    scope: AnswerReuseScope,
    start: () => Promise<StartedConversation>,
    signal: AbortSignal | undefined,
  ) {
    const entry: Entry = {
      ...scope,
      state: "running",
      start: Promise.resolve().then(start),
      started: null,
      leaderSignal: signal,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    // Followers handle the rejection themselves; never an unhandled one.
    entry.start.catch(() => {});
    entries.set(key, entry);
    evict();
    let started: StartedConversation;
    try {
      started = await entry.start;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
    entry.started = started;
    if (started.commitSha !== scope.commitSha) {
      // The engine resolved a different commit than the key names (a branch
      // moved meanwhile): this run answers another key. Never store it, and
      // let no later question join it.
      if (entries.get(key) === entry) entries.delete(key);
      return { started, reuse: null };
    }
    void watch(key, entry, started);
    return { started, reuse: null };
  }

  return {
    get size() {
      return entries.size;
    },
    async acquire(key, scope, start, signal) {
      if (!options.enabled()) return { started: await start(), reuse: null };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const entry = entries.get(key);
        if (!entry || entry.ownerId !== scope.ownerId) return lead(key, scope, start, signal);
        if (entry.state === "done") {
          const started = entry.started;
          if (
            started &&
            entry.expiresAt > clock() &&
            (await options.stillValid(scope.ownerId, started.runId).catch(() => false))
          ) {
            // Invalidated (or replaced) while it was being checked: a miss.
            if (entries.get(key) !== entry) continue;
            entries.delete(key);
            entries.set(key, entry);
            return { started, reuse: "cache" as const };
          }
          if (entries.get(key) === entry) entries.delete(key);
          continue;
        }
        try {
          return { started: await abortable(entry.start, signal), reuse: "in-flight" as const };
        } catch (error) {
          if (signal?.aborted || !entry.leaderSignal?.aborted || attempt > 0) throw error;
          // The leader's request went away mid-start: try once as the leader.
        }
      }
      return lead(key, scope, start, signal);
    },
    invalidateOwner(ownerId) {
      drop((entry) => entry.ownerId === ownerId);
    },
    invalidatePackage(packageId) {
      drop((entry) => entry.packageId === packageId);
    },
    invalidateRepository(repositoryId, ownerId) {
      drop(
        (entry) =>
          entry.repositoryId === repositoryId &&
          (ownerId === undefined || entry.ownerId === ownerId),
      );
    },
    clear() {
      entries.clear();
    },
  };
}

let shared: AnswerReuse | undefined;
let unsubscribeRepositoryChanges: (() => void) | undefined;

/**
 * The process-wide answer reuse (COCKPIT_CONTEXT_ANSWER_CACHE_*), built by the
 * MCP server with the engine-backed `settle` / `stillValid`. Invalidation
 * callers (`invalidateAnswersFor*`) are no-ops until it exists.
 */
export function configureAnswerReuse(
  hooks: Pick<AnswerReuseOptions, "settle" | "stillValid">,
): AnswerReuse {
  const reuse = createAnswerReuse({
    enabled: () => env.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED,
    ttlMs: () => env.COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS * 1_000,
    maxEntries: () => env.COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES,
    ...hooks,
  });
  shared = reuse;
  // An explicit re-fetch or a delete of a repository drops its answers for
  // every owner. Routine fetches (`fetched`) do not: the key holds the commit,
  // so a moved ref is already a different key.
  unsubscribeRepositoryChanges?.();
  unsubscribeRepositoryChanges = onRepositoryChange((repositoryId, reason) => {
    if (reason !== "fetched") reuse.invalidateRepository(repositoryId);
  });
  return reuse;
}

/** Notes, subdirectory or source of a package changed, or it was removed. */
export function invalidateAnswersForPackage(packageId: string): void {
  shared?.invalidatePackage(packageId);
}

/** The owner's overview override of a checkout of this repository changed. */
export function invalidateAnswersForRepository(repositoryId: string, ownerId?: string): void {
  shared?.invalidateRepository(repositoryId, ownerId);
}

/** The owner was archived or deleted. */
export function invalidateAnswersForOwner(ownerId: string): void {
  shared?.invalidateOwner(ownerId);
}
