import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const state = vi.hoisted(() => ({
  dataDir: "",
  remoteDir: "",
  fail: false,
  // Thrown by the next connect instead of running git (a timeout, a policy refusal).
  failWith: null as unknown,
}));
vi.mock("./config", () => ({
  dataDir: () => state.dataDir,
  fetchIntervalMs: () => 300_000,
  gitHostAllowlist: () => [],
}));
// The only mocked boundary is the network: instead of DNS pinning and SSH
// material, point the remote URL at a local fixture over file://.
const networkCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("./network", () => ({
  withGitNetwork: async (spec: unknown, fn: (network: unknown) => Promise<unknown>) => {
    networkCalls.push(spec);
    if (state.fail) throw Object.assign(new Error("connect refused"), { code: "GIT_FAILED" });
    if (state.failWith) throw state.failWith;
    return fn({
      config: [
        "protocol.file.allow=always",
        `url.file://${state.remoteDir}.insteadOf=https://example.com/o/r`,
        `url.file://${state.remoteDir}.insteadOf=ssh://git@example.com/o/r`,
      ],
      env: {},
    });
  },
}));

const { default: prisma } = await import("@cockpit-context/db");
const { installFakeRows } = await import("./test-support/fake-git-db");
const { createFixtureRepo, fixtureGit } = await import("./test-support/fixture-repo");
const repos = await import("./repositories");
const { onRepositoryChange } = await import("./repository-change-hooks");
const { repositoryDir } = await import("./paths");
const { GitCommandError } = await import("./git-exec");
const { RepoError } = await import("./errors");

type Fake = ReturnType<typeof installFakeRows>;
const db = prisma as unknown as Parameters<typeof installFakeRows>[0];

let root: string;
let shas: Awaited<ReturnType<typeof createFixtureRepo>>["shas"];
let fake: Fake;

const pkg = {
  id: "pkg0000000001",
  ownerId: "user-1",
  ecosystem: "NPM" as const,
  name: "@scope/pkg",
  gitUrl: "https://example.com/o/r",
  sshKeyId: null,
  isSnapshot: false,
  repositoryId: null,
  tagPattern: null,
  defaultRef: null,
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-repositories-"));
  const fixture = await createFixtureRepo(path.join(root, "fixture"));
  state.remoteDir = fixture.workDir;
  shas = fixture.shas;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  networkCalls.length = 0;
  state.fail = false;
  state.failWith = null;
  state.dataDir = await mkdtemp(path.join(root, "data-"));
  fake = installFakeRows(db);
});

describe("ensureRepository", () => {
  it("creates a shared PUBLIC row for HTTPS, links the package and clones bare+blobless", async () => {
    const repo = await repos.ensureRepository({
      gitUrl: pkg.gitUrl,
      ownerId: "user-1",
      packageId: pkg.id,
    });
    expect(db.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { remoteKey_ownerScope: { remoteKey: "https://example.com/o/r", ownerScope: "" } },
        create: expect.objectContaining({
          visibility: "PUBLIC",
          ownerId: null,
          ownerScope: "",
          sshKeyId: null,
        }),
      }),
    );
    expect(db.package.updateMany).toHaveBeenCalledWith({
      where: {
        id: pkg.id,
        ownerId: "user-1",
        OR: [{ repositoryId: null }, { repositoryId: { not: repo.id } }],
      },
      data: { repositoryId: repo.id },
    });
    expect(repo).toMatchObject({ status: "READY", defaultBranch: "main", lastError: null });
    expect(repo.diskBytes).toBeGreaterThan(0n);
    const dir = repositoryDir(repo.id);
    expect((await stat(path.join(dir, "HEAD"))).isFile()).toBe(true);
    expect(await fixtureGit(dir, "config", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/heads/*",
    );
    expect(await fixtureGit(dir, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
    // Staging directories never survive.
    expect(await readdir(path.join(state.dataDir, "repos"))).toEqual([`${repo.id}.git`]);
  });

  it("does not clone again when the clone is READY", async () => {
    await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-2" });
    expect(networkCalls).toHaveLength(1);
    expect(fake.repositories.size).toBe(1);
  });

  it("re-clones a READY row whose clone was pruned from disk", async () => {
    const first = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    await rm(repositoryDir(first.id), { recursive: true });
    await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    expect(networkCalls).toHaveLength(2);
  });

  it("requires an own SSH key for SSH remotes and keys PRIVATE rows by owner", async () => {
    await expect(
      repos.ensureRepository({ gitUrl: "git@github.com:o/r.git", ownerId: "user-1" }),
    ).rejects.toMatchObject({ code: "SSH_KEY_REQUIRED" });

    db.sshKey.findFirst?.mockResolvedValue(null);
    await expect(
      repos.ensureRepository({
        gitUrl: "git@github.com:o/r.git",
        ownerId: "user-1",
        sshKeyId: "someone-elses",
      }),
    ).rejects.toMatchObject({ code: "SSH_KEY_NOT_FOUND" });
    expect(db.sshKey.findFirst).toHaveBeenCalledWith({
      where: { id: "someone-elses", ownerId: "user-1" },
      select: { id: true },
    });

    db.sshKey.findFirst?.mockResolvedValue({ id: "key-1" });
    state.fail = true;
    await expect(
      repos.ensureRepository({
        gitUrl: "git@github.com:o/r.git",
        ownerId: "user-1",
        sshKeyId: "key-1",
      }),
    ).rejects.toThrow();
    expect(db.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          remoteKey_ownerScope: { remoteKey: "ssh://git@github.com/o/r", ownerScope: "user-1" },
        },
        create: expect.objectContaining({
          visibility: "PRIVATE",
          ownerId: "user-1",
          sshKeyId: "key-1",
        }),
        update: { sshKeyId: "key-1" },
      }),
    );
  });

  it("refuses an invalid URL before touching the database", async () => {
    await expect(
      repos.ensureRepository({ gitUrl: "file:///etc", ownerId: "user-1" }),
    ).rejects.toMatchObject({
      code: "INVALID_REMOTE_URL",
    });
    expect(db.repository.upsert).not.toHaveBeenCalled();
  });

  it("marks a failed clone FAILED with the error and leaves no staging dir", async () => {
    state.fail = true;
    await expect(repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" })).rejects.toThrow(
      "connect refused",
    );
    const [row] = fake.repositories.values();
    expect(row).toMatchObject({ status: "FAILED", lastError: "connect refused" });
    expect(await readdir(path.join(state.dataDir, "repos"))).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("resolves against the clone without fetching while fresh", async () => {
    const now = new Date();
    const result = await repos.resolveTarget(
      { package: pkg, version: "2.0.0" },
      { now: () => now },
    );
    expect(result).toMatchObject({ sha: shas.two, resolvedFrom: "tag:@scope/pkg@2.0.0" });
    const branch = await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    expect(branch).toMatchObject({ sha: shas.four, resolvedFrom: "branch:main" });
    expect(networkCalls).toHaveLength(1); // the clone only
  });

  it("records package usage only after a successful resolution, scoped to its owner and clone", async () => {
    const at = new Date("2026-10-26T10:00:00Z");
    const target = await repos.resolveTarget({ package: pkg, version: "2.0.0" }, { now: () => at });
    expect(db.package.updateMany).toHaveBeenCalledWith({
      where: { id: pkg.id, ownerId: pkg.ownerId, repositoryId: target.repositoryId },
      data: { lastUsedAt: at },
    });

    db.package.updateMany?.mockClear();
    await expect(
      repos.resolveTarget({ package: pkg, version: "999.0.0" }, { npmGitHead: async () => null }),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    expect(db.package.updateMany?.mock.calls.some(([input]) => "lastUsedAt" in input.data)).toBe(
      false,
    );
  });

  it("fetches a stale branch and sees new commits", async () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    await repos.resolveTarget({ package: pkg }, { now: () => t0 });
    const newSha = await (async () => {
      await fixtureGit(state.remoteDir, "commit", "--quiet", "--allow-empty", "-m", "five");
      return fixtureGit(state.remoteDir, "rev-parse", "HEAD");
    })();
    try {
      const fresh = await repos.resolveTarget(
        { package: pkg },
        { now: () => new Date(t0.getTime() + 60_000) },
      );
      expect(fresh).toMatchObject({ sha: shas.four, stale: false, fetchedAt: t0 });
      const stale = await repos.resolveTarget(
        { package: pkg },
        { now: () => new Date(t0.getTime() + 301_000) },
      );
      expect(stale).toMatchObject({
        sha: newSha,
        resolvedFrom: "branch:main",
        stale: false,
        fetchedAt: new Date(t0.getTime() + 301_000),
      });
    } finally {
      await fixtureGit(state.remoteDir, "reset", "--quiet", "--hard", shas.four);
    }
  });

  it("keeps resolving against local refs when a staleness fetch fails", async () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    await repos.resolveTarget({ package: pkg }, { now: () => t0 });
    state.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await repos.resolveTarget(
      { package: pkg, ref: "feature" },
      { now: () => new Date(t0.getTime() + 10 * 60_000) },
    );
    expect(result).toMatchObject({
      sha: shas.feature,
      resolvedFrom: "branch:feature",
      stale: true,
      fetchedAt: t0,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fetches a commit only the server has by id, through the pinned network path", async () => {
    const now = new Date();
    await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    const tree = await fixtureGit(state.remoteDir, "rev-parse", `${shas.four}^{tree}`);
    const prSha = await fixtureGit(state.remoteDir, "commit-tree", tree, "-m", "pr only");
    await fixtureGit(state.remoteDir, "update-ref", "refs/pull/9/head", prSha);
    networkCalls.length = 0;
    try {
      const result = await repos.resolveTarget({ package: pkg, ref: prSha }, { now: () => now });
      expect(result).toMatchObject({ sha: prSha, resolvedFrom: "commit" });
      // One pinned connect: the fetch by id (no branch or tag fetch).
      expect(networkCalls).toHaveLength(1);
      expect(await fixtureGit(repositoryDir(result.repositoryId), "cat-file", "-t", prSha)).toBe(
        "commit",
      );
    } finally {
      await fixtureGit(state.remoteDir, "update-ref", "-d", "refs/pull/9/head");
    }
  });

  it("is REF_NOT_FOUND for a full commit id the server does not have", async () => {
    const now = new Date();
    await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    await expect(
      repos.resolveTarget({ package: pkg, ref: "c".repeat(40) }, { now: () => now }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });

  it("fetchCommitLocked is false only when the server lacks the object", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    await expect(repos.fetchCommitLocked(repo, "c".repeat(40), {}, {})).resolves.toBe(false);
    await expect(repos.fetchCommitLocked(repo, shas.two, {}, {})).resolves.toBe(true);
    const timeout = new GitCommandError("GIT_TIMEOUT", "git fetch timed out after 120s.", null, "");
    state.failWith = timeout;
    await expect(repos.fetchCommitLocked(repo, "c".repeat(40), {}, {})).rejects.toBe(timeout);
  });

  it("reports a fetch by id that timed out or was refused as itself, not as a missing ref", async () => {
    const now = new Date();
    await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    for (const failure of [
      new GitCommandError("GIT_TIMEOUT", "git fetch timed out after 120s.", null, ""),
      new RepoError("PRIVATE_ADDRESS", "That host resolves to a private address."),
      // Same exit code as a missing object, other words: a connection or auth failure.
      new GitCommandError(
        "GIT_FAILED",
        "git fetch failed: fatal: Could not read from remote repository.",
        128,
        "fatal: Could not read from remote repository.",
      ),
    ]) {
      state.failWith = failure;
      await expect(
        repos.resolveTarget({ package: pkg, ref: "d".repeat(40) }, { now: () => now }),
      ).rejects.toBe(failure);
    }
  });

  it("writes the repository's lastUsedAt once per resolution", async () => {
    const now = new Date();
    await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    db.repository.update?.mockClear();
    await repos.resolveTarget({ package: pkg, ref: "main" }, { now: () => now });
    const touches = (db.repository.update?.mock.calls ?? []).filter(
      ([input]) => "lastUsedAt" in input.data,
    );
    expect(touches).toHaveLength(1);
    // Other callers of the READY fast path still record use.
    db.repository.update?.mockClear();
    await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    expect(
      (db.repository.update?.mock.calls ?? []).filter(([input]) => "lastUsedAt" in input.data),
    ).toHaveLength(1);
  });

  it("uses the npm gitHead fallback with a mocked registry", async () => {
    const npmGitHead = vi.fn(async () => shas.feature);
    const result = await repos.resolveTarget({ package: pkg, version: "7.7.7" }, { npmGitHead });
    expect(result).toMatchObject({ sha: shas.feature, resolvedFrom: "npm-gitHead" });
  });
});

describe("fetchRepository", () => {
  it("fetches tags and records lastFetchedAt", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    await fixtureGit(state.remoteDir, "tag", "v8.0.0", shas.one);
    const at = new Date("2026-05-05T00:00:00Z");
    const changed: string[] = [];
    const unsubscribe = onRepositoryChange((id, reason) => changed.push(`${id}:${reason}`));
    const fetched = await repos.fetchRepository(repo.id, { mode: "tags" }, { now: () => at });
    unsubscribe();
    expect(fetched.lastFetchedAt).toEqual(at);
    // The fetch itself (any fetch: version caches drop) and the explicit
    // re-fetch (reused answers drop too).
    expect(changed).toEqual([`${repo.id}:fetched`, `${repo.id}:refetched`]);
    expect(await fixtureGit(repositoryDir(repo.id), "rev-parse", "refs/tags/v8.0.0^{commit}")).toBe(
      shas.one,
    );
  });

  it("keeps local tags that moved upstream and still takes every other tag", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    await fixtureGit(state.remoteDir, "tag", "--force", "1.1.0", shas.two);
    await fixtureGit(state.remoteDir, "tag", "v8.1.0", shas.feature);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const at = new Date("2026-05-06T00:00:00Z");
      const fetched = await repos.fetchRepository(repo.id, { mode: "tags" }, { now: () => at });
      expect(fetched).toMatchObject({ status: "READY", lastError: null, lastFetchedAt: at });
      const dir = repositoryDir(repo.id);
      expect(await fixtureGit(dir, "rev-parse", "refs/tags/1.1.0^{commit}")).toBe(shas.one);
      expect(await fixtureGit(dir, "rev-parse", "refs/tags/v8.1.0^{commit}")).toBe(shas.feature);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/moved upstream: 1\.1\.0$/));
    } finally {
      warn.mockRestore();
      await fixtureGit(state.remoteDir, "tag", "--force", "1.1.0", shas.one);
      await fixtureGit(state.remoteDir, "tag", "-d", "v8.1.0");
    }
  });

  it("is REPOSITORY_NOT_FOUND for an unknown id", async () => {
    await expect(repos.fetchRepository("missing000001")).rejects.toMatchObject({
      code: "REPOSITORY_NOT_FOUND",
    });
  });
});

describe("deleteRepository", () => {
  it("refuses while a checkout is leased, unless forced", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    db.checkoutLease.count?.mockResolvedValue(1);
    await expect(repos.deleteRepository(repo.id)).rejects.toMatchObject({
      code: "CHECKOUT_LEASED",
    });
    const changed: string[] = [];
    const unsubscribe = onRepositoryChange((id, reason) => changed.push(`${id}:${reason}`));
    const result = await repos.deleteRepository(repo.id, { force: true });
    unsubscribe();
    expect(changed).toEqual([`${repo.id}:deleted`]);
    expect(result.freedBytes).toBeGreaterThan(0n);
    await expect(stat(repositoryDir(repo.id))).rejects.toThrow();
    expect(db.repository.delete).toHaveBeenCalledWith({
      where: { id: repo.id },
      select: { id: true },
    });
  });
});

describe("measure", () => {
  it("stores sizes from the injected size function", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    const result = await repos.measure(
      repo.id,
      {},
      {
        measure: async () => ({ bytes: 1234n, entries: 1, truncated: false }),
      },
    );
    expect(result).toEqual({ repositoryBytes: 1234n, checkouts: [], totalBytes: 1234n });
    expect(fake.repositories.get(repo.id)?.diskBytes).toBe(1234n);
  });

  it("writes only sizes that changed", async () => {
    const repo = await repos.ensureRepository({ gitUrl: pkg.gitUrl, ownerId: "user-1" });
    fake.checkouts.set("chk0000000001", {
      id: "chk0000000001",
      createdAt: new Date(),
      repositoryId: repo.id,
      sha: shas.four,
      resolvedFrom: null,
      status: "READY",
      lastError: null,
      diskBytes: 0n,
      lastUsedAt: null,
      summaryStatus: "NONE",
    });
    db.repository.update?.mockClear();
    let bytes = 1234n;
    const deps = { measure: async () => ({ bytes, entries: 1, truncated: false }) };

    await repos.measure(repo.id, {}, deps);
    expect(db.repository.update).toHaveBeenCalledTimes(1);
    expect(db.checkout.update).toHaveBeenCalledTimes(1);
    expect(db.checkout.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ select: { id: true, sha: true, diskBytes: true } }),
    );

    db.repository.update?.mockClear();
    db.checkout.update?.mockClear();
    const again = await repos.measure(repo.id, {}, deps);
    expect(again).toEqual({
      repositoryBytes: 1234n,
      checkouts: [{ id: "chk0000000001", bytes: 1234n }],
      totalBytes: 2468n,
    });
    expect(db.repository.update).not.toHaveBeenCalled();
    expect(db.checkout.update).not.toHaveBeenCalled();

    bytes = 99n;
    await repos.measure(repo.id, {}, deps);
    expect(db.repository.update).toHaveBeenCalledTimes(1);
    expect(db.checkout.update).toHaveBeenCalledTimes(1);
    expect(fake.repositories.get(repo.id)?.diskBytes).toBe(99n);
    expect(fake.checkouts.get("chk0000000001")?.diskBytes).toBe(99n);
  });
});

describe("isFetchStale", () => {
  it("is stale when never fetched or older than the interval", () => {
    const at = new Date("2026-01-01T00:10:00Z");
    expect(repos.isFetchStale(null, at, 300_000)).toBe(true);
    expect(repos.isFetchStale(new Date("2026-01-01T00:05:00Z"), at, 300_000)).toBe(true);
    expect(repos.isFetchStale(new Date("2026-01-01T00:06:00Z"), at, 300_000)).toBe(false);
  });
});

describe("parseSymrefHead", () => {
  it("reads the remote HEAD branch", () => {
    expect(repos.parseSymrefHead(`ref: refs/heads/trunk\tHEAD\n${"a".repeat(40)}\tHEAD\n`)).toBe(
      "trunk",
    );
    expect(repos.parseSymrefHead("garbage")).toBeNull();
  });
});

describe("clobberedTags", () => {
  const from = "From https://example.com/o/r";
  const clobber = (tag: string) =>
    ` ! [rejected]        ${tag}         -> ${tag}  (would clobber existing tag)`;

  it("names the moved tags when they are the only rejections", () => {
    expect(
      repos.clobberedTags(
        [
          from,
          "   1a2b3c4..5d6e7f8  main       -> main",
          " * [new tag]         v3         -> v3",
          " + 1a2b3c4...5d6e7f8 dev        -> dev  (forced update)",
          " - [deleted]         (none)     -> gone",
          clobber("v1"),
          clobber("@scope/pkg@1.0.0"),
          "",
        ].join("\n"),
      ),
    ).toEqual(["v1", "@scope/pkg@1.0.0"]);
  });

  it("is null for any other rejection, error or unknown line", () => {
    for (const stderr of [
      "",
      from,
      `${from}\n${clobber("v1")}\n ! [rejected]        main       -> main  (non-fast-forward)`,
      `${clobber("v1")}\nerror: cannot lock ref 'refs/tags/v2': unable to create lock`,
      `${clobber("v1")}\nfatal: the remote end hung up unexpectedly`,
      `${clobber("v1")}\nremote: something`,
      `${clobber("v1")}\n ! [remote rejected] v2 -> v2 (would clobber existing tag)`,
    ]) {
      expect(repos.clobberedTags(stderr)).toBeNull();
    }
  });
});

describe("snapshot repositories", () => {
  const source = { gitUrl: "ssh://git@example.com/o/r", ownerId: "user-1" };
  const key = "ONE_TIME_KEY_SENTINEL";
  const snapshotPkg = (repositoryId: string) => ({
    ...pkg,
    ...source,
    isSnapshot: true,
    repositoryId,
    ecosystem: "GIT" as const,
  });

  it("isolates clones across users and packages and never persists key material", async () => {
    const a = await repos.createSnapshotRepository(source, key);
    const b = await repos.createSnapshotRepository({ ...source, ownerId: "user-2" }, key);
    const c = await repos.createSnapshotRepository(source, key);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(a).toMatchObject({
      isSnapshot: true,
      visibility: "PRIVATE",
      ownerId: "user-1",
      sshKeyId: null,
      status: "READY",
    });
    // Full clone: local checkouts need no lazy blob fetch.
    expect(
      await fixtureGit(
        repositoryDir(a.id),
        "config",
        "--get",
        "remote.origin.partialclonefilter",
      ).catch(() => ""),
    ).toBe("");
    const writes = [
      ...(db.repository.create?.mock.calls ?? []),
      ...(db.repository.update?.mock.calls ?? []),
      ...(db.package.updateMany?.mock.calls ?? []),
    ];
    expect(
      JSON.stringify(writes, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain(key);
  });

  it("never auto-fetches even stale branches and reports missing refs without registry requests", async () => {
    const a = await repos.createSnapshotRepository(source, key);
    networkCalls.length = 0;
    const npmGitHead = vi.fn();
    await repos.resolveTarget(
      { package: snapshotPkg(a.id), ref: "main" },
      { now: () => new Date("2030-01-01"), npmGitHead },
    );
    await repos.fetchRepository(a.id);
    for (const request of [
      { ref: "missing-tag" },
      { version: "999.0.0" },
      { ref: "b".repeat(40) },
    ]) {
      await expect(
        repos.resolveTarget(
          { package: { ...snapshotPkg(a.id), ecosystem: "NPM" }, ...request },
          { npmGitHead },
        ),
      ).rejects.toMatchObject({ code: "PACKAGE_SNAPSHOT_REF_MISSING" });
    }
    expect(networkCalls).toHaveLength(0);
    expect(npmGitHead).not.toHaveBeenCalled();
  });

  it("updates tags only on an explicit pasted-key update, records its timestamp, and scopes by owner", async () => {
    const a = await repos.createSnapshotRepository(source, key);
    const name = "snapshot-added-tag";
    await fixtureGit(state.remoteDir, "tag", "-f", name);
    const packageInput = snapshotPkg(a.id);
    await expect(repos.resolveTarget({ package: packageInput, ref: name })).rejects.toMatchObject({
      code: "PACKAGE_SNAPSHOT_REF_MISSING",
    });
    await expect(repos.updateSnapshotRepository(a.id, "user-2", key)).rejects.toMatchObject({
      code: "PACKAGE_SNAPSHOT_REF_MISSING",
    });
    const at = new Date("2030-01-01");
    const updated = await repos.updateSnapshotRepository(a.id, "user-1", key, { now: () => at });
    expect(updated.lastFetchedAt).toEqual(at);
    await expect(repos.resolveTarget({ package: packageInput, ref: name })).resolves.toMatchObject({
      resolvedFrom: `tag:${name}`,
    });
    await fixtureGit(state.remoteDir, "tag", "-d", name);
  });

  it("does not re-clone a manually removed snapshot without a key", async () => {
    const a = await repos.createSnapshotRepository(source, key);
    await rm(repositoryDir(a.id), { recursive: true, force: true });
    networkCalls.length = 0;
    await expect(repos.resolveTarget({ package: snapshotPkg(a.id) })).rejects.toMatchObject({
      code: "PACKAGE_SNAPSHOT_REF_MISSING",
    });
    expect(networkCalls).toHaveLength(0);
  });

  it("sanitizes thrown errors and persisted failure text", async () => {
    const a = await repos.createSnapshotRepository(source, key);
    state.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = await repos
        .updateSnapshotRepository(a.id, "user-1", key)
        .catch((error: unknown) => error);
      expect(String(error)).not.toContain(key);
      expect(error).not.toHaveProperty("cause");
      expect(repos.safeSnapshotError(new Error(key)).message).not.toContain(key);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
      expect(fake.repositories.get(a.id)?.lastError).toBe("Snapshot operation failed.");
    } finally {
      warn.mockRestore();
    }
  });
});

it("materializes and rebuilds snapshot checkouts without any network invocation", async () => {
  const repo = await repos.createSnapshotRepository(
    { gitUrl: "ssh://git@example.com/o/r", ownerId: "user-1" },
    "KEY",
  );
  const { ensureCheckout, deleteCheckout } = await import("./checkouts");
  networkCalls.length = 0;
  const checkout = await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
  expect(checkout.status).toBe("READY");
  await deleteCheckout(checkout.id);
  await ensureCheckout({ repositoryId: repo.id, sha: shas.two });
  expect(networkCalls).toHaveLength(0);
});
