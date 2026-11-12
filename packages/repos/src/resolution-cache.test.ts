import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/server", () => ({
  env: {
    COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS: 300,
    COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES: 2,
  },
}));
vi.mock("./repositories", () => ({ resolveTarget: vi.fn() }));

const { createResolutionCache } = await import("./resolution-cache");
const { notifyRepositoryChange } = await import("./repository-change-hooks");

import type { ResolvedTarget, ResolveTargetInput } from "./repositories";

const SHA = "a".repeat(40);

function input(overrides: Partial<ResolveTargetInput> = {}, pkg: Record<string, unknown> = {}) {
  return {
    version: "1.3.0",
    ref: null,
    ...overrides,
    package: {
      id: "pkg1",
      ownerId: "user-a",
      ecosystem: "NPM",
      name: "left-pad",
      gitUrl: "https://github.com/o/left-pad",
      sshKeyId: null,
      isSnapshot: false,
      repositoryId: "repo1",
      tagPattern: null,
      defaultRef: null,
      ...pkg,
    },
  } as ResolveTargetInput;
}

function setup(resolved: Partial<ResolvedTarget> = {}, ttlMs = 300_000) {
  let clock = 1_000;
  const resolver = vi.fn(
    async (): Promise<ResolvedTarget> => ({
      sha: SHA,
      resolvedFrom: "tag:v1.3.0",
      repositoryId: "repo1",
      stale: false,
      fetchedAt: null,
      ...resolved,
    }),
  );
  const cache = createResolutionCache(
    { ttlMs: () => ttlMs, maxEntries: () => 2, now: () => clock },
    resolver,
  );
  return { cache, resolver, advance: (ms: number) => (clock += ms) };
}

describe("createResolutionCache", () => {
  it("reuses an exact-version resolution until the TTL runs out", async () => {
    const { cache, resolver, advance } = setup();
    await cache.resolve(input());
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(1);
    advance(299_999);
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(1);
    advance(2);
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("never caches a branch, a stale result or a snapshot package", async () => {
    const branch = setup({ resolvedFrom: "branch:main" });
    await branch.cache.resolve(input({ version: null }));
    await branch.cache.resolve(input({ version: null }));
    expect(branch.resolver).toHaveBeenCalledTimes(2);

    const stale = setup({ stale: true });
    await stale.cache.resolve(input());
    await stale.cache.resolve(input());
    expect(stale.resolver).toHaveBeenCalledTimes(2);

    const snapshot = setup();
    await snapshot.cache.resolve(input({}, { isSnapshot: true }));
    await snapshot.cache.resolve(input({}, { isSnapshot: true }));
    expect(snapshot.resolver).toHaveBeenCalledTimes(2);
  });

  it("caches npm gitHead and full-commit resolutions", async () => {
    const npm = setup({ resolvedFrom: "npm-gitHead" });
    await npm.cache.resolve(input());
    await npm.cache.resolve(input());
    expect(npm.resolver).toHaveBeenCalledTimes(1);
    const commit = setup({ resolvedFrom: "commit" });
    await commit.cache.resolve(input({ version: null, ref: SHA }));
    await commit.cache.resolve(input({ version: null, ref: SHA }));
    expect(commit.resolver).toHaveBeenCalledTimes(1);
  });

  it("keys by package (never across owners) and by every resolution input", async () => {
    const { cache, resolver } = setup();
    await cache.resolve(input());
    await cache.resolve(input({}, { id: "pkg2", ownerId: "user-b" }));
    await cache.resolve(input({}, { tagPattern: "release-{version}" }));
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("is off with a zero TTL", async () => {
    const { cache, resolver } = setup({}, 0);
    await cache.resolve(input());
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("is bounded: the least recently used entry goes first", async () => {
    const { cache, resolver } = setup();
    await cache.resolve(input({ version: "1.0.0" }));
    await cache.resolve(input({ version: "2.0.0" }));
    await cache.resolve(input({ version: "1.0.0" })); // refresh 1.0.0
    await cache.resolve(input({ version: "3.0.0" })); // evicts 2.0.0
    expect(cache.size).toBe(2);
    await cache.resolve(input({ version: "1.0.0" }));
    expect(resolver).toHaveBeenCalledTimes(3);
    await cache.resolve(input({ version: "2.0.0" }));
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it("drops a repository's and a package's entries when told", async () => {
    const { cache, resolver } = setup();
    await cache.resolve(input());
    cache.invalidateRepository("repo1");
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(2);
    cache.invalidatePackage("pkg1");
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(3);
  });
});

describe("the process-wide cache", () => {
  it("is dropped for a repository on a re-fetch or delete notification", async () => {
    const { resolutionCache } = await import("./resolution-cache");
    const { resolveTarget } = await import("./repositories");
    vi.mocked(resolveTarget).mockResolvedValue({
      sha: SHA,
      resolvedFrom: "tag:v1.3.0",
      repositoryId: "repo1",
      stale: false,
      fetchedAt: null,
    });
    await resolutionCache.resolve(input());
    await resolutionCache.resolve(input());
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    notifyRepositoryChange("repo1", "refetched");
    await resolutionCache.resolve(input());
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    // Any fetch (an automatic one during another resolution) drops it too.
    notifyRepositoryChange("repo1", "fetched");
    await resolutionCache.resolve(input());
    expect(resolveTarget).toHaveBeenCalledTimes(3);
  });
});

describe("resolutions in progress", () => {
  function blockingSetup() {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onResolve: () => void = () => {};
    const resolver = vi.fn(async (): Promise<ResolvedTarget> => {
      onResolve();
      await blocked;
      return {
        sha: SHA,
        resolvedFrom: "tag:v1.3.0",
        repositoryId: "repo1",
        stale: false,
        fetchedAt: null,
      };
    });
    const cache = createResolutionCache({ ttlMs: () => 300_000, maxEntries: () => 10 }, resolver);
    return {
      cache,
      resolver,
      release: () => release(),
      setOnResolve: (fn: () => void) => (onResolve = fn),
    };
  }

  it("are not stored when another caller invalidates the repository meanwhile", async () => {
    const { cache, resolver, release } = blockingSetup();
    const pending = cache.resolve(input());
    await Promise.resolve();
    cache.invalidateRepository("repo1");
    release();
    await pending;
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("are not stored when their package is invalidated meanwhile", async () => {
    const { cache, resolver, release } = blockingSetup();
    const pending = cache.resolve(input());
    await Promise.resolve();
    cache.invalidatePackage("pkg1");
    release();
    await pending;
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("are still stored when the invalidation is their own fetch", async () => {
    const { cache, resolver, release, setOnResolve } = blockingSetup();
    // The resolver's own fetch notifies from inside the resolution.
    setOnResolve(() => cache.invalidateRepository("repo1"));
    const pending = cache.resolve(input());
    release();
    await pending;
    await cache.resolve(input());
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
