import { AsyncLocalStorage } from "node:async_hooks";

import { env } from "@cockpit-context/env/server";

import { type ResolvedTarget, type ResolveTargetInput, resolveTarget } from "./repositories";
import { onRepositoryChange } from "./repository-change-hooks";

/**
 * A bounded, TTL'd memo of version → commit resolutions (in process: one app
 * replica, docs/hosting.md), so repeated questions about the same exact
 * version skip the tag fetch and the npm registry lookup.
 *
 * What is cached: only results that cannot move under a well-behaved remote —
 * `tag:*`, `npm-gitHead` and full `commit` resolutions. Branch and
 * default-branch resolutions (`branch:*`) never are (branches move; the
 * fetch interval already bounds their cost), nor stale results (a failed
 * refresh), nor snapshot packages (resolved locally, no network).
 *
 * The key is the package row's resolution inputs plus the requested version
 * or ref, so it never crosses owners (the package id is per owner) and a
 * package edit (git URL, SSH key, tag pattern) is a different key. Entries
 * also drop on `invalidateRepository` (any fetch, explicit re-fetch, delete)
 * and `invalidatePackage` (package edit or removal). A resolution still in
 * progress when another caller invalidates its repository is not stored: it
 * may have read the refs before they moved. Its own fetch (the resolver
 * fetching on its way) does not count; that read is the fresh one.
 *
 * A hit skips `resolveTarget`, so it also skips that call's `lastUsedAt`
 * touches; the run that follows still leases and materializes the checkout.
 */
export interface ResolutionCacheOptions {
  /** 0 disables the cache. */
  ttlMs: () => number;
  maxEntries: () => number;
  now?: () => number;
}

type Entry = { value: ResolvedTarget; expiresAt: number; packageId: string };

export interface ResolutionCache {
  resolve(input: ResolveTargetInput): Promise<ResolvedTarget>;
  /** Drop the repository's entries (and spoil resolutions in progress, except the caller's own). */
  invalidateRepository(repositoryId: string): void;
  invalidatePackage(packageId: string): void;
  clear(): void;
  readonly size: number;
}

const CACHEABLE = /^(tag:|npm-gitHead$|commit$)/;

function keyOf(input: ResolveTargetInput): string {
  const pkg = input.package;
  return JSON.stringify([
    pkg.id,
    pkg.ownerId,
    pkg.ecosystem,
    pkg.name,
    pkg.gitUrl,
    pkg.sshKeyId,
    pkg.repositoryId,
    pkg.tagPattern,
    pkg.defaultRef,
    input.version ?? null,
    input.ref ?? null,
  ]);
}

export function createResolutionCache(
  options: ResolutionCacheOptions,
  resolver: (input: ResolveTargetInput) => Promise<ResolvedTarget> = (input) =>
    resolveTarget(input),
): ResolutionCache {
  const entries = new Map<string, Entry>();
  const clock = options.now ?? Date.now;
  /** Resolutions in progress; each collects repositories invalidated by someone else meanwhile. */
  type Pending = { packageId: string; spoiled: Set<string>; packageSpoiled: boolean };
  const pending = new Set<Pending>();
  const current = new AsyncLocalStorage<Pending>();

  return {
    get size() {
      return entries.size;
    },
    async resolve(input) {
      const ttlMs = options.ttlMs();
      if (ttlMs <= 0 || input.package.isSnapshot) return resolver(input);
      const key = keyOf(input);
      const hit = entries.get(key);
      if (hit && hit.expiresAt > clock()) {
        // Refresh recency (Map order is the LRU order).
        entries.delete(key);
        entries.set(key, hit);
        return { ...hit.value };
      }
      if (hit) entries.delete(key);
      const record: Pending = {
        packageId: input.package.id,
        spoiled: new Set(),
        packageSpoiled: false,
      };
      pending.add(record);
      let value: ResolvedTarget;
      try {
        value = await current.run(record, () => resolver(input));
      } finally {
        pending.delete(record);
      }
      if (
        !value.stale &&
        CACHEABLE.test(value.resolvedFrom) &&
        !record.packageSpoiled &&
        !record.spoiled.has(value.repositoryId)
      ) {
        entries.set(key, {
          value: { ...value },
          expiresAt: clock() + ttlMs,
          packageId: input.package.id,
        });
        const max = Math.max(1, options.maxEntries());
        while (entries.size > max) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      return value;
    },
    invalidateRepository(repositoryId) {
      for (const [key, entry] of entries) {
        if (entry.value.repositoryId === repositoryId) entries.delete(key);
      }
      const origin = current.getStore();
      for (const record of pending) if (record !== origin) record.spoiled.add(repositoryId);
    },
    invalidatePackage(packageId) {
      for (const [key, entry] of entries) {
        if (entry.packageId === packageId) entries.delete(key);
      }
      // The package row changed: a resolution of it in progress used the old one.
      for (const record of pending) {
        if (record.packageId === packageId) record.packageSpoiled = true;
      }
    },
    clear() {
      entries.clear();
    },
  };
}

/** The process-wide cache (COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS / _MAX_ENTRIES). */
export const resolutionCache: ResolutionCache = createResolutionCache({
  ttlMs: () => env.COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS * 1_000,
  maxEntries: () => env.COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES,
});

onRepositoryChange((repositoryId) => resolutionCache.invalidateRepository(repositoryId));

/** `resolveTarget` through the process-wide cache. */
export function cachedResolveTarget(input: ResolveTargetInput): Promise<ResolvedTarget> {
  return resolutionCache.resolve(input);
}
