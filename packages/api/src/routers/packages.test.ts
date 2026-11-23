import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
// The Cockpit Context rate budgets at their defaults: the procedure budgets read them on first consume.
vi.mock("@cockpit-context/env/server", async () => {
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  return { env: cockpitContextRateBudgetEnvDefaults(), ADMIN_EMAILS: new Set<string>() };
});
vi.mock("@cockpit-context/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/repos")>()),
  validateRemoteUrl: vi.fn(),
  lookupRegistry: vi.fn(),
  createSnapshotRepositoryRow: vi.fn(),
  cloneRepository: vi.fn(),
  updateSnapshotRepository: vi.fn(),
  importSshKey: vi.fn(),
  normalizeImportedPrivateKey: vi.fn(),
  deleteRepository: vi.fn(),
}));

vi.mock("@cockpit-context/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/jobs")>()),
  enqueueJob: vi.fn(),
}));
vi.mock("@cockpit-context/runs/answer-reuse", () => ({ invalidateAnswersForPackage: vi.fn() }));
const { invalidateAnswersForPackage } = await import("@cockpit-context/runs/answer-reuse");

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { packagesRouter } = await import("./packages");

const db = prisma as unknown as {
  package: {
    findMany: MockInstance;
    findFirst: MockInstance;
    create: MockInstance;
    updateMany: MockInstance;
    deleteMany: MockInstance;
  };
  sshKey: { findFirst: MockInstance };
};
const validateRemoteUrl = repos.validateRemoteUrl as unknown as MockInstance;
const lookupRegistry = repos.lookupRegistry as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");

function packageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pkg-1",
    createdAt: NOW,
    updatedAt: NOW,
    identifier: "npm:left-pad",
    ecosystem: "NPM",
    name: "left-pad",
    displayName: "left-pad",
    gitUrl: "https://github.com/a/left-pad",
    subdirectory: null,
    tagPattern: null,
    defaultRef: null,
    lastUsedAt: null,
    notes: "my notes",
    SshKey: null,
    Repository: {
      id: "repo-1",
      status: "READY",
      visibility: "PUBLIC",
      defaultBranch: "main",
      lastFetchedAt: NOW,
      snapshotSyncStatus: "NONE",
      snapshotSyncError: null,
      snapshotSyncStartedAt: null,
      Checkouts: [
        {
          id: "co-1",
          sha: "a".repeat(40),
          resolvedFrom: "tag:v1",
          status: "READY",
          lastUsedAt: NOW,
        },
      ],
      _count: { Checkouts: 1 },
    },
    ...overrides,
  };
}

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(packagesRouter, { context });
}

function expectCode(code: string) {
  return (error: ORPCError<string, unknown>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    return true;
  };
}

/** The owner clause `findOwnedOrThrow` ANDs onto a query. */
const ownedBy = (id: string) =>
  expect.objectContaining({ AND: [expect.anything(), { ownerId: id }] });

describe("packagesRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateRemoteUrl.mockResolvedValue({
      kind: "https",
      host: "github.com",
      port: 443,
      remoteUrl: "https://github.com/a/left-pad",
      remoteKey: "https://github.com/a/left-pad",
    });
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).list({})).rejects.toSatisfy(expectCode("UNAUTHORIZED"));
  });

  describe("list", () => {
    it("scopes to the caller and pages by a composite cursor", async () => {
      db.package.findMany.mockResolvedValue([packageRow()]);
      const result = await client().list({ limit: 10 });
      const args = db.package.findMany.mock.calls[0]?.[0];
      expect(args.where).toEqual({ AND: [{ ownerId: "user-a" }] });
      expect(args.take).toBe(11);
      expect(result.nextCursor).toBeNull();
      expect(result.items[0]).toMatchObject({
        identifier: "npm:left-pad",
        ecosystem: "npm",
        checkoutCount: 1,
        recentCheckouts: [{ id: "co-1", status: "ready" }],
        repository: { status: "ready", visibility: "public" },
      });
      // Notes are detail-only.
      expect(result.items[0]).not.toHaveProperty("notes");
    });

    it("filters by ecosystem in the stored spelling", async () => {
      db.package.findMany.mockResolvedValue([]);
      await client().list({ ecosystem: "pypi" });
      expect(db.package.findMany.mock.calls[0]?.[0].where).toEqual({
        AND: [{ ownerId: "user-a", ecosystem: "PYPI" }],
      });
    });
  });

  describe("get", () => {
    it("returns an own package with notes", async () => {
      db.package.findFirst.mockResolvedValue(packageRow());
      const result = await client().get({ id: "pkg-1" });
      expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "pkg-1" }, { ownerId: "user-a" }],
      });
      expect(result.notes).toBe("my notes");
      expect(Object.keys(result).sort()).toEqual(
        [
          "checkoutCount",
          "createdAt",
          "defaultRef",
          "displayName",
          "ecosystem",
          "gitUrl",
          "id",
          "identifier",
          "isSnapshot",
          "lastUsedAt",
          "name",
          "notes",
          "recentCheckouts",
          "repository",
          "sshKey",
          "subdirectory",
          "tagPattern",
          "updatedAt",
        ].sort(),
      );
    });

    it("is NOT_FOUND for another user's package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(client(sessionContext({ id: "user-b" })).get({ id: "pkg-1" })).rejects.toSatisfy(
        expectCode("NOT_FOUND"),
      );
      expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual(ownedBy("user-b"));
    });
  });

  describe("create", () => {
    it("normalizes the name, builds the identifier and stores the validated URL", async () => {
      db.package.create.mockResolvedValue(packageRow());
      await client().create({
        ecosystem: "npm",
        name: "Left-Pad",
        gitUrl: "https://github.com/a/left-pad.git",
      });
      expect(validateRemoteUrl).toHaveBeenCalledWith("https://github.com/a/left-pad.git");
      expect(db.package.create.mock.calls[0]?.[0].data).toMatchObject({
        ownerId: "user-a",
        identifier: "npm:left-pad",
        ecosystem: "NPM",
        name: "left-pad",
        displayName: "left-pad",
        gitUrl: "https://github.com/a/left-pad",
        sshKeyId: null,
      });
    });

    it("rejects an invalid name before any network call", async () => {
      await expect(
        client().create({ ecosystem: "npm", name: "../etc", gitUrl: "https://github.com/a/b" }),
      ).rejects.toSatisfy(expectCode("BAD_REQUEST"));
      expect(validateRemoteUrl).not.toHaveBeenCalled();
    });

    it("needs one of the caller's SSH keys for an SSH remote", async () => {
      validateRemoteUrl.mockResolvedValue({
        kind: "ssh",
        host: "git.example.com",
        port: 22,
        remoteUrl: "git@git.example.com:a/b",
        remoteKey: "ssh://git@git.example.com/~/a/b",
      });
      await expect(
        client().create({ ecosystem: "git", name: "a/b", gitUrl: "git@git.example.com:a/b" }),
      ).rejects.toSatisfy((error: ORPCError<string, { reason: string }>) => {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.data.reason).toBe("SSH_KEY_REQUIRED");
        return true;
      });

      db.sshKey.findFirst.mockResolvedValue(null);
      await expect(
        client().create({
          ecosystem: "git",
          name: "a/b",
          gitUrl: "git@git.example.com:a/b",
          sshKeyId: "someone-elses-key",
        }),
      ).rejects.toSatisfy(expectCode("NOT_FOUND"));
      expect(db.sshKey.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "someone-elses-key" }, { ownerId: "user-a" }],
      });
      expect(db.package.create).not.toHaveBeenCalled();
    });

    it("maps a duplicate identifier to CONFLICT / PACKAGE_EXISTS", async () => {
      db.package.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
      await expect(
        client().create({ ecosystem: "npm", name: "left-pad", gitUrl: "https://github.com/a/b" }),
      ).rejects.toSatisfy((error: ORPCError<string, { reason: string }>) => {
        expect(error.code).toBe("CONFLICT");
        expect(error.data.reason).toBe("PACKAGE_EXISTS");
        return true;
      });
    });

    it("maps git-layer URL errors to their reason codes", async () => {
      validateRemoteUrl.mockRejectedValue(
        new repos.RepoError("PRIVATE_ADDRESS", "10.0.0.1 is private (internal detail)"),
      );
      await expect(
        client().create({ ecosystem: "npm", name: "x", gitUrl: "https://internal.example/a/b" }),
      ).rejects.toSatisfy((error: ORPCError<string, { reason: string }>) => {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.data.reason).toBe("PRIVATE_ADDRESS");
        expect(error.message).not.toContain("10.0.0.1");
        return true;
      });
    });
  });

  describe("update", () => {
    it("is NOT_FOUND for another user's package and writes nothing", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).update({ id: "pkg-1", notes: "x" }),
      ).rejects.toSatisfy(expectCode("NOT_FOUND"));
      expect(db.package.updateMany).not.toHaveBeenCalled();
    });

    it("re-validates a changed URL and unlinks the old repository", async () => {
      db.package.findFirst
        .mockResolvedValueOnce({ id: "pkg-1", gitUrl: "https://github.com/a/old", sshKeyId: null })
        .mockResolvedValueOnce(packageRow());
      db.package.updateMany.mockResolvedValue({ count: 1 });
      await client().update({ id: "pkg-1", gitUrl: "https://github.com/a/left-pad" });
      expect(db.package.updateMany).toHaveBeenCalledWith({
        where: { id: "pkg-1", ownerId: "user-a" },
        data: {
          gitUrl: "https://github.com/a/left-pad",
          sshKeyId: null,
          repositoryId: null,
          isSnapshot: false,
        },
      });
    });

    it("keeps the repository when only notes change", async () => {
      db.package.findFirst
        .mockResolvedValueOnce({ id: "pkg-1", gitUrl: "https://github.com/a/b", sshKeyId: null })
        .mockResolvedValueOnce(packageRow());
      db.package.updateMany.mockResolvedValue({ count: 1 });
      await client().update({ id: "pkg-1", notes: "use the v5 API" });
      expect(db.package.updateMany).toHaveBeenCalledWith({
        where: { id: "pkg-1", ownerId: "user-a" },
        data: { notes: "use the v5 API" },
      });
      expect(validateRemoteUrl).not.toHaveBeenCalled();
    });

    it("drops the package's reused answers and cached resolutions on any edit", async () => {
      const forgetResolutions = vi.spyOn(repos.resolutionCache, "invalidatePackage");
      db.package.findFirst
        .mockResolvedValueOnce({ id: "pkg-1", gitUrl: "https://github.com/a/b", sshKeyId: null })
        .mockResolvedValueOnce(packageRow());
      db.package.updateMany.mockResolvedValue({ count: 1 });
      await client().update({ id: "pkg-1", notes: "use the v6 API" });
      expect(invalidateAnswersForPackage).toHaveBeenCalledWith("pkg-1");
      expect(forgetResolutions).toHaveBeenCalledWith("pkg-1");
    });
  });

  describe("delete", () => {
    it("deletes only the caller's row", async () => {
      db.package.deleteMany.mockResolvedValue({ count: 1 });
      await expect(client().delete({ id: "pkg-1" })).resolves.toEqual({ ok: true });
      expect(db.package.deleteMany).toHaveBeenCalledWith({
        where: { id: "pkg-1", ownerId: "user-a" },
      });
      expect(invalidateAnswersForPackage).toHaveBeenCalledWith("pkg-1");
    });

    it("is NOT_FOUND when nothing of the caller's matched", async () => {
      db.package.deleteMany.mockResolvedValue({ count: 0 });
      await expect(client().delete({ id: "pkg-x" })).rejects.toSatisfy(expectCode("NOT_FOUND"));
    });
  });

  describe("lookupRegistry", () => {
    it("returns the registry's suggestion", async () => {
      lookupRegistry.mockResolvedValue({
        status: "found",
        suggestion: {
          ecosystem: "npm",
          name: "left-pad",
          displayName: "left-pad",
          gitUrl: "https://github.com/a/left-pad",
          subdirectory: null,
          latestVersion: "1.3.0",
          homepage: null,
        },
      });
      await expect(
        client().lookupRegistry({ ecosystem: "npm", name: "Left-Pad" }),
      ).resolves.toMatchObject({
        status: "found",
        gitUrl: "https://github.com/a/left-pad",
        latestVersion: "1.3.0",
      });
      expect(lookupRegistry).toHaveBeenCalledWith({ ecosystem: "npm", name: "left-pad" });
    });

    it("passes not_found through and never looks up an invalid name", async () => {
      lookupRegistry.mockResolvedValue({ status: "not_found" });
      await expect(client().lookupRegistry({ ecosystem: "cargo", name: "nope" })).resolves.toEqual({
        status: "not_found",
      });
      await expect(
        client().lookupRegistry({ ecosystem: "cargo", name: "../../x" }),
      ).rejects.toSatisfy(expectCode("BAD_REQUEST"));
      expect(lookupRegistry).toHaveBeenCalledTimes(1);
    });
  });
});

describe("one-time SSH packages", () => {
  const key = { privateKey: "PRIVATE_SENTINEL", passphrase: "PHRASE_SENTINEL", save: false };
  const input = {
    ecosystem: "git" as const,
    name: "owner/private",
    gitUrl: "git@example.com:owner/private",
    oneTimeKey: key,
  };
  const snapshot = {
    id: "pkg-snapshot",
    ownerId: "snapshot-owner",
    gitUrl: input.gitUrl,
    sshKeyId: null,
    isSnapshot: true,
    repositoryId: "repo-snapshot",
  };
  const owner = () => client(sessionContext({ id: "snapshot-owner" }));
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  /** A clone/refresh that finishes when the test says so. */
  const gate = () => {
    let release: (error?: Error) => void = () => {};
    const promise = new Promise<never>((resolve, reject) => {
      release = (error) => (error ? reject(error) : resolve(undefined as never));
    });
    return { promise, release };
  };
  const repoWrites = () =>
    vi.mocked(prisma.repository.updateMany).mock.calls.map((call) => call[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      if (typeof fn !== "function") throw new Error("test expects callback transaction");
      return fn(prisma);
    });
    validateRemoteUrl.mockResolvedValue({ kind: "ssh", remoteUrl: input.gitUrl });
    vi.mocked(repos.normalizeImportedPrivateKey).mockResolvedValue({
      privateKey: "NORMALIZED_SENTINEL",
      publicKey: { keyType: "ssh-ed25519", publicKey: "public", fingerprint: "fp" },
    });
    vi.mocked(repos.createSnapshotRepositoryRow).mockResolvedValue({
      id: "repo-snapshot",
    } as Awaited<ReturnType<typeof repos.createSnapshotRepositoryRow>>);
    vi.mocked(repos.cloneRepository).mockResolvedValue(
      {} as Awaited<ReturnType<typeof repos.cloneRepository>>,
    );
    vi.mocked(repos.updateSnapshotRepository).mockResolvedValue(
      {} as Awaited<ReturnType<typeof repos.updateSnapshotRepository>>,
    );
    vi.mocked(repos.importSshKey).mockResolvedValue({ id: "saved-key" } as Awaited<
      ReturnType<typeof repos.importSshKey>
    >);
    vi.mocked(prisma.repository.updateMany).mockResolvedValue({ count: 1 });
    db.package.create.mockResolvedValue(packageRow({ isSnapshot: true }));
    db.package.updateMany.mockResolvedValue({ count: 1 });
  });

  const assertNoPersistedSecret = async () => {
    const { enqueueJob } = await import("@cockpit-context/jobs");
    const writes = [
      db.package.create.mock.calls,
      db.package.updateMany.mock.calls,
      vi.mocked(prisma.repository.updateMany).mock.calls,
      vi.mocked(prisma.sshKey.create).mock.calls,
      vi.mocked(enqueueJob).mock.calls,
    ];
    const text = JSON.stringify(writes);
    for (const secret of [key.privateKey, key.passphrase, "NORMALIZED_SENTINEL"])
      expect(text).not.toContain(secret);
  };

  it("answers before the clone, which runs in the background with the key in memory only", async () => {
    const clone = gate();
    vi.mocked(repos.cloneRepository).mockReturnValueOnce(clone.promise);
    await owner().create(input);
    expect(repos.normalizeImportedPrivateKey).toHaveBeenCalledWith(key.privateKey, key.passphrase);
    expect(repos.createSnapshotRepositoryRow).toHaveBeenCalledWith({
      gitUrl: input.gitUrl,
      ownerId: "snapshot-owner",
    });
    expect(db.package.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isSnapshot: true,
          repositoryId: "repo-snapshot",
          sshKeyId: null,
        }),
      }),
    );
    // The request is done; the clone is still running, marked durably.
    expect(repoWrites()).toContainEqual(
      expect.objectContaining({
        where: { id: "repo-snapshot", ownerId: "snapshot-owner", isSnapshot: true },
        data: expect.objectContaining({ snapshotSyncStatus: "RUNNING", snapshotSyncError: null }),
      }),
    );
    expect(repos.cloneRepository).toHaveBeenCalledWith("repo-snapshot", {
      privateKey: "NORMALIZED_SENTINEL",
      signal: expect.any(AbortSignal),
    });
    expect(repoWrites().some((write) => write.data.snapshotSyncStatus === "NONE")).toBe(false);
    clone.release();
    await settle();
    expect(repoWrites()).toContainEqual({
      where: { id: "repo-snapshot", snapshotSyncStatus: "RUNNING" },
      data: { snapshotSyncStatus: "NONE", snapshotSyncError: null },
    });
    expect(repos.importSshKey).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("records a failed clone as FAILED with its code only, never the key or git output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(repos.cloneRepository).mockRejectedValueOnce(
      new repos.RepoError("HOST_KEY_UNCONFIRMED", key.privateKey, { host: "example.com" }),
    );
    try {
      await owner().create(input);
      await settle();
      expect(repoWrites()).toContainEqual({
        where: { id: "repo-snapshot", snapshotSyncStatus: "RUNNING" },
        data: { snapshotSyncStatus: "FAILED", snapshotSyncError: "HOST_KEY_UNCONFIRMED" },
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(key.privateKey);
      await assertNoPersistedSecret();
    } finally {
      warn.mockRestore();
    }
  });

  it("save checkbox goes through the existing encrypted import path and creates a normal package", async () => {
    await owner().create({ ...input, oneTimeKey: { ...key, save: true, name: "deploy" } });
    expect(repos.importSshKey).toHaveBeenCalledWith({
      ownerId: "snapshot-owner",
      name: "deploy",
      privateKey: key.privateKey,
      passphrase: key.passphrase,
    });
    expect(repos.createSnapshotRepositoryRow).not.toHaveBeenCalled();
    expect(repos.cloneRepository).not.toHaveBeenCalled();
    expect(db.package.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sshKeyId: "saved-key", isSnapshot: false }),
      }),
    );
  });

  it("drops the prepared row and never clones when the package cannot be created", async () => {
    db.package.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(owner().create(input)).rejects.toBeDefined();
    expect(repos.deleteRepository).toHaveBeenCalledWith("repo-snapshot");
    expect(repos.cloneRepository).not.toHaveBeenCalled();
  });

  it("refreshes in the background on update, and a second update while it runs joins it", async () => {
    const refresh = gate();
    vi.mocked(repos.updateSnapshotRepository).mockReturnValueOnce(refresh.promise);
    db.package.findFirst.mockResolvedValue(snapshot);
    await expect(owner().updateSnapshot({ id: snapshot.id, key })).resolves.toEqual({
      ok: true,
      syncing: true,
    });
    expect(db.package.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: snapshot.id, isSnapshot: true }, { ownerId: "snapshot-owner" }],
    });
    expect(repos.updateSnapshotRepository).toHaveBeenCalledWith(
      "repo-snapshot",
      "snapshot-owner",
      "NORMALIZED_SENTINEL",
      {},
      { signal: expect.any(AbortSignal) },
    );
    await owner().updateSnapshot({ id: snapshot.id, key });
    expect(repos.updateSnapshotRepository).toHaveBeenCalledTimes(1);
    refresh.release();
    await settle();
    expect(invalidateAnswersForPackage).toHaveBeenCalledWith(snapshot.id);
    expect(repos.importSshKey).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("with save, stores the key, turns the package into an SSH package and queues a normal fetch", async () => {
    const { enqueueJob } = await import("@cockpit-context/jobs");
    db.package.findFirst.mockResolvedValue(snapshot);
    await expect(
      owner().updateSnapshot({ id: snapshot.id, key: { ...key, save: true, name: "deploy" } }),
    ).resolves.toEqual({ ok: true, syncing: true });
    expect(repos.importSshKey).toHaveBeenCalledTimes(1);
    expect(db.package.updateMany).toHaveBeenCalledWith({
      where: {
        id: snapshot.id,
        ownerId: "snapshot-owner",
        isSnapshot: true,
        repositoryId: "repo-snapshot",
      },
      data: { isSnapshot: false, sshKeyId: "saved-key" },
    });
    expect(repoWrites()).toContainEqual({
      where: { id: "repo-snapshot", ownerId: "snapshot-owner" },
      data: {
        isSnapshot: false,
        sshKeyId: "saved-key",
        snapshotSyncStatus: "NONE",
        snapshotSyncError: null,
      },
    });
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "repository.fetch" }),
      { repositoryId: "repo-snapshot", mode: "default" },
      expect.objectContaining({ dedupeKey: expect.stringContaining("repo-snapshot") }),
    );
    expect(repos.updateSnapshotRepository).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("serializes a re-key and a save on one package: the save converts the clone the re-key attached", async () => {
    // A tiny package row: the snapshot's clone was deleted (repositoryId null).
    let repositoryId: string | null = null;
    let isSnapshot = true;
    db.package.findFirst.mockImplementation(async () =>
      isSnapshot ? { ...snapshot, repositoryId } : null,
    );
    db.package.updateMany.mockImplementation(
      async (args: { data: { repositoryId?: string; isSnapshot?: boolean } }) => {
        if (args.data.repositoryId) repositoryId = args.data.repositoryId;
        if (args.data.isSnapshot === false) isSnapshot = false;
        return { count: 1 };
      },
    );
    let seen: AbortSignal | undefined;
    vi.mocked(repos.cloneRepository).mockImplementationOnce(
      (_id, options) =>
        new Promise((_, reject) => {
          seen = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    const [refresh, save] = await Promise.all([
      owner().updateSnapshot({ id: snapshot.id, key }),
      owner().updateSnapshot({ id: snapshot.id, key: { ...key, save: true, name: "deploy" } }),
    ]);
    expect(refresh).toEqual({ ok: true, syncing: true });
    expect(save).toEqual({ ok: true, syncing: true });
    // The save saw the replacement clone: it converted it, killed its task and queued its fetch.
    expect(repoWrites()).toContainEqual(
      expect.objectContaining({
        where: { id: "repo-snapshot", ownerId: "snapshot-owner" },
        data: expect.objectContaining({ isSnapshot: false, sshKeyId: "saved-key" }),
      }),
    );
    expect(seen?.aborted).toBe(true);
    await settle();
    db.package.findFirst.mockReset();
    db.package.updateMany.mockReset();
  });

  it("a delete racing a re-key never leaves the re-key's replacement clone running or on disk", async () => {
    let repositoryId: string | null = null;
    let exists = true;
    db.package.findFirst.mockImplementation(async () =>
      exists ? { ...snapshot, repositoryId } : null,
    );
    db.package.updateMany.mockImplementation(async (args: { data: { repositoryId?: string } }) => {
      if (args.data.repositoryId) repositoryId = args.data.repositoryId;
      return { count: 1 };
    });
    db.package.deleteMany.mockImplementation(async () => {
      exists = false;
      return { count: 1 };
    });
    let rowCreated: () => void = () => {};
    const created = new Promise<void>((resolve) => {
      rowCreated = resolve;
    });
    vi.mocked(repos.createSnapshotRepositoryRow).mockImplementationOnce(async () => {
      rowCreated();
      return { id: "repo-replacement" } as Awaited<
        ReturnType<typeof repos.createSnapshotRepositoryRow>
      >;
    });
    let seen: AbortSignal | undefined;
    vi.mocked(repos.cloneRepository).mockImplementationOnce(
      (_id, options) =>
        new Promise((_, reject) => {
          seen = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    const rekey = owner().updateSnapshot({ id: snapshot.id, key });
    // The delete arrives while the re-key is attaching its replacement clone.
    await created;
    const removal = owner().delete({ id: snapshot.id });
    await expect(rekey).resolves.toEqual({ ok: true, syncing: true });
    await expect(removal).resolves.toEqual({ ok: true });
    // The delete saw the replacement: killed its clone and removed it.
    expect(seen?.aborted).toBe(true);
    expect(repos.deleteRepository).toHaveBeenCalledWith("repo-replacement", { lockWaitMs: 10_000 });
    await settle();
    db.package.findFirst.mockReset();
    db.package.updateMany.mockReset();
    db.package.deleteMany.mockReset();
  });

  it("re-clones a manually deleted snapshot only when the user supplies a key", async () => {
    db.package.findFirst.mockResolvedValue({ ...snapshot, repositoryId: null });
    await owner().updateSnapshot({ id: snapshot.id, key });
    expect(repos.createSnapshotRepositoryRow).toHaveBeenCalled();
    expect(db.package.updateMany).toHaveBeenCalledWith({
      where: { id: snapshot.id, ownerId: "snapshot-owner", isSnapshot: true, repositoryId: null },
      data: { repositoryId: "repo-snapshot" },
    });
    await settle();
    expect(repos.cloneRepository).toHaveBeenCalled();
    expect(repos.updateSnapshotRepository).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("refuses another user's package before key validation or network IO", async () => {
    db.package.findFirst.mockResolvedValue(null);
    await expect(owner().updateSnapshot({ id: snapshot.id, key })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(repos.normalizeImportedPrivateKey).not.toHaveBeenCalled();
    expect(repos.createSnapshotRepositoryRow).not.toHaveBeenCalled();
  });

  it("converts to an owned saved key through the edit sheet's existing validation", async () => {
    // The package, its repository read again inside the gate, the result.
    db.package.findFirst
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(packageRow());
    db.sshKey.findFirst.mockResolvedValue({ id: "saved-key" });
    await owner().update({ id: snapshot.id, sshKeyId: "saved-key" });
    expect(db.sshKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: "saved-key" }, { ownerId: "snapshot-owner" }] },
      }),
    );
    expect(db.package.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSnapshot: false, sshKeyId: "saved-key" }),
      }),
    );
    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
      where: { id: "repo-snapshot", ownerId: "snapshot-owner", isSnapshot: true },
      data: {
        isSnapshot: false,
        sshKeyId: "saved-key",
        snapshotSyncStatus: "NONE",
        snapshotSyncError: null,
      },
    });
  });

  it("kills a running pasted-key clone when the edit sheet turns the snapshot into an SSH package", async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(repos.updateSnapshotRepository).mockImplementationOnce(
      (_id, _owner, _key, _deps, options) =>
        new Promise((_, reject) => {
          seen = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    // updateSnapshot reads the package, then its repository again inside the gate.
    db.package.findFirst.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot);
    await owner().updateSnapshot({ id: snapshot.id, key });
    // The package, its repository read again inside the gate, the result.
    db.package.findFirst
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(packageRow());
    db.sshKey.findFirst.mockResolvedValue({ id: "saved-key" });
    await owner().update({ id: snapshot.id, sshKeyId: "saved-key" });
    expect(seen?.aborted).toBe(true);
    await settle();
  });

  it("keeps the snapshot if the chosen saved key belongs to another user", async () => {
    db.package.findFirst.mockResolvedValue(snapshot);
    db.sshKey.findFirst.mockResolvedValue(null);
    await expect(
      owner().update({ id: snapshot.id, sshKeyId: "foreign-key" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.package.updateMany).not.toHaveBeenCalled();
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  it("sanitizes dependency errors before persistence, logs or client errors can contain the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(repos.createSnapshotRepositoryRow).mockRejectedValueOnce(
      new repos.RepoError("GIT_FAILED", key.privateKey + key.passphrase),
    );
    try {
      const error = await owner()
        .create(input)
        .catch((error: unknown) => error);
      const text =
        String(error) +
        JSON.stringify(error) +
        JSON.stringify(warn.mock.calls) +
        JSON.stringify(log.mock.calls);
      expect(text).not.toContain(key.privateKey);
      expect(text).not.toContain(key.passphrase);
      expect(db.package.create).not.toHaveBeenCalled();
      await assertNoPersistedSecret();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it.each([
    "SSH_KEY_INVALID",
    "SSH_KEY_PASSPHRASE_REQUIRED",
    "SSH_KEY_PASSPHRASE_INVALID",
    "SSH_KEY_UNSUPPORTED",
    "SSH_KEY_PASSPHRASE_TOO_LONG",
  ] as const)("preserves validation reason %s without echoing input", async (code) => {
    vi.mocked(repos.normalizeImportedPrivateKey).mockRejectedValueOnce(
      new repos.RepoError(code, key.privateKey),
    );
    await expect(owner().create(input)).rejects.toMatchObject({
      data: { reason: code },
      message: expect.not.stringContaining(key.privateKey),
    });
    expect(db.package.create).not.toHaveBeenCalled();
  });

  it("bounds key and passphrase requests before any work", async () => {
    await expect(
      owner().create({ ...input, oneTimeKey: { privateKey: "x".repeat(16_385) } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      owner().create({ ...input, oneTimeKey: { privateKey: "x", passphrase: "x".repeat(4097) } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(repos.normalizeImportedPrivateKey).not.toHaveBeenCalled();
  });

  it("on delete, cancels a clone still running, then deletes the clone with a bounded lock wait", async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(repos.cloneRepository).mockImplementationOnce(
      (_id, options) =>
        new Promise((_, reject) => {
          seen = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("killed")), {
            once: true,
          });
        }),
    );
    await owner().create(input);
    db.package.findFirst.mockResolvedValue({ repositoryId: "repo-snapshot" });
    db.package.deleteMany.mockResolvedValue({ count: 1 });
    await owner().delete({ id: snapshot.id });
    expect(seen?.aborted).toBe(true);
    // The delete did not wait for the clone to unwind; it records its end on its own.
    await settle();
    expect(repoWrites()).toContainEqual({
      where: { id: "repo-snapshot", snapshotSyncStatus: "RUNNING" },
      data: { snapshotSyncStatus: "FAILED", snapshotSyncError: "SNAPSHOT_CANCELLED" },
    });
    expect(repos.deleteRepository).toHaveBeenCalledWith("repo-snapshot", { lockWaitMs: 10_000 });
  });

  it("answers REPOSITORY_BUSY instead of waiting on a long clone or fetch", async () => {
    db.package.findFirst.mockResolvedValue({ repositoryId: "repo-snapshot" });
    vi.mocked(repos.deleteRepository).mockRejectedValueOnce(
      new repos.RepoError("REPOSITORY_BUSY", "busy"),
    );
    await expect(owner().delete({ id: snapshot.id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "REPOSITORY_BUSY" },
    });
    expect(db.package.deleteMany).not.toHaveBeenCalled();
  });
});

it("cleans an unlinked replacement snapshot when another request changed the package", async () => {
  vi.clearAllMocks();
  vi.mocked(repos.deleteRepository).mockResolvedValue({ freedBytes: 0n });
  db.package.findFirst.mockResolvedValue({
    id: "pkg-race",
    repositoryId: null,
    gitUrl: "git@example.com:owner/private",
  });
  validateRemoteUrl.mockResolvedValue({ kind: "ssh" });
  vi.mocked(repos.normalizeImportedPrivateKey).mockResolvedValue({
    privateKey: "normalized",
    publicKey: { keyType: "ssh-ed25519", publicKey: "public", fingerprint: "fp" },
  });
  vi.mocked(repos.createSnapshotRepositoryRow).mockResolvedValue({ id: "orphan-repo" } as Awaited<
    ReturnType<typeof repos.createSnapshotRepositoryRow>
  >);
  vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
    if (typeof fn !== "function") throw new Error("test expects callback transaction");
    return fn(prisma);
  });
  db.package.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    client(sessionContext({ id: "race-owner" })).updateSnapshot({
      id: "pkg-race",
      key: { privateKey: "pasted" },
    }),
  ).rejects.toMatchObject({ data: { reason: "PACKAGE_SNAPSHOT_REF_MISSING" } });
  expect(repos.deleteRepository).toHaveBeenCalledWith("orphan-repo");
  // Nothing was cloned for the row that lost the race.
  expect(repos.cloneRepository).not.toHaveBeenCalled();
});
