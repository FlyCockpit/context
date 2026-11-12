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
  createSnapshotRepository: vi.fn(),
  updateSnapshotRepository: vi.fn(),
  importSshKey: vi.fn(),
  normalizeImportedPrivateKey: vi.fn(),
  deleteRepository: vi.fn(),
}));

vi.mock("@cockpit-context/jobs", () => ({ enqueueJob: vi.fn() }));
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
    vi.mocked(repos.createSnapshotRepository).mockResolvedValue({ id: "repo-snapshot" } as Awaited<
      ReturnType<typeof repos.createSnapshotRepository>
    >);
    vi.mocked(repos.updateSnapshotRepository).mockResolvedValue({ id: "repo-snapshot" } as Awaited<
      ReturnType<typeof repos.updateSnapshotRepository>
    >);
    vi.mocked(repos.importSshKey).mockResolvedValue({ id: "saved-key" } as Awaited<
      ReturnType<typeof repos.importSshKey>
    >);
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
    expect(enqueueJob).not.toHaveBeenCalled();
  };

  it("clones immediately, stores only snapshot metadata and never queues or stores credentials", async () => {
    await owner().create(input);
    expect(repos.normalizeImportedPrivateKey).toHaveBeenCalledWith(key.privateKey, key.passphrase);
    expect(repos.createSnapshotRepository).toHaveBeenCalledWith(
      { gitUrl: input.gitUrl, ownerId: "snapshot-owner" },
      "NORMALIZED_SENTINEL",
    );
    expect(db.package.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isSnapshot: true,
          repositoryId: "repo-snapshot",
          sshKeyId: null,
        }),
      }),
    );
    expect(repos.importSshKey).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("save checkbox goes through the existing encrypted import path and creates a normal package", async () => {
    await owner().create({ ...input, oneTimeKey: { ...key, save: true, name: "deploy" } });
    expect(repos.importSshKey).toHaveBeenCalledWith({
      ownerId: "snapshot-owner",
      name: "deploy",
      privateKey: key.privateKey,
      passphrase: key.passphrase,
    });
    expect(repos.createSnapshotRepository).not.toHaveBeenCalled();
    expect(db.package.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sshKeyId: "saved-key", isSnapshot: false }),
      }),
    );
  });

  it.each([false, true])("updates inline with save=%s", async (save) => {
    db.package.findFirst.mockResolvedValue(snapshot);
    await owner().updateSnapshot({
      id: snapshot.id,
      key: { ...key, save, name: save ? "deploy" : undefined },
    });
    expect(repos.updateSnapshotRepository).toHaveBeenCalledWith(
      "repo-snapshot",
      "snapshot-owner",
      "NORMALIZED_SENTINEL",
    );
    expect(db.package.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: snapshot.id, isSnapshot: true }, { ownerId: "snapshot-owner" }],
    });
    expect(db.package.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: save
          ? { repositoryId: "repo-snapshot", isSnapshot: false, sshKeyId: "saved-key" }
          : { repositoryId: "repo-snapshot" },
      }),
    );
    expect(repos.importSshKey).toHaveBeenCalledTimes(save ? 1 : 0);
    await assertNoPersistedSecret();
  });

  it("re-clones a manually deleted snapshot only when the user supplies a key", async () => {
    db.package.findFirst.mockResolvedValue({ ...snapshot, repositoryId: null });
    await owner().updateSnapshot({ id: snapshot.id, key });
    expect(repos.createSnapshotRepository).toHaveBeenCalled();
    expect(repos.updateSnapshotRepository).not.toHaveBeenCalled();
    await assertNoPersistedSecret();
  });

  it("refuses another user's package before key validation or network IO", async () => {
    db.package.findFirst.mockResolvedValue(null);
    await expect(owner().updateSnapshot({ id: snapshot.id, key })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(repos.normalizeImportedPrivateKey).not.toHaveBeenCalled();
    expect(repos.createSnapshotRepository).not.toHaveBeenCalled();
  });

  it("converts to an owned saved key through the edit sheet's existing validation", async () => {
    db.package.findFirst.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(packageRow());
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
      data: { isSnapshot: false, sshKeyId: "saved-key" },
    });
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
    vi.mocked(repos.createSnapshotRepository).mockRejectedValueOnce(
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

  it("deletes the protected clone on an owner's confirmed package deletion", async () => {
    db.package.findFirst.mockResolvedValue({ repositoryId: "repo-snapshot" });
    db.package.deleteMany.mockResolvedValue({ count: 1 });
    await owner().delete({ id: snapshot.id });
    expect(repos.deleteRepository).toHaveBeenCalledWith("repo-snapshot");
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
  vi.mocked(repos.createSnapshotRepository).mockResolvedValue({ id: "orphan-repo" } as Awaited<
    ReturnType<typeof repos.createSnapshotRepository>
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
});
