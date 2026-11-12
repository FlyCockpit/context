import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  // Interactive transactions run against the same deep mock.
  db.$transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === "function" ? fn(db) : Promise.all(fn as Promise<unknown>[]),
  );
  return { default: db };
});
vi.mock("@cockpit-context/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
const budget = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  keys: [] as string[],
  errorQueue: [] as unknown[],
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    budget.options.push(options);
    return async (key: string) => {
      budget.keys.push(`${String(options.keyPrefix)}:${key}`);
      const error = budget.errorQueue.shift();
      if (error) throw error;
    };
  },
}));
vi.mock("@cockpit-context/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/repos")>()),
  validateRemoteUrl: vi.fn(),
  normalizeImportedPrivateKey: vi.fn(),
  createSnapshotRepository: vi.fn(),
  deleteRepository: vi.fn(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { proposalsRouter } = await import("./proposals");

const db = prisma as unknown as {
  packageProposal: {
    findMany: MockInstance;
    findFirst: MockInstance;
    count: MockInstance;
    updateMany: MockInstance;
  };
  package: { findFirst: MockInstance; create: MockInstance };
};
const validateRemoteUrl = repos.validateRemoteUrl as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    createdAt: NOW,
    status: "PENDING",
    ecosystem: "PYPI",
    name: "requests",
    identifier: "pypi:requests",
    displayName: "requests",
    gitUrl: "https://github.com/psf/requests",
    subdirectory: null,
    version: "2.32.0",
    reason: "Need to read the retry adapter",
    rejectionReason: null,
    decidedAt: null,
    packageId: null,
    connectionLabel: "Claude Code",
    ...overrides,
  };
}

const createdPackage = {
  id: "pkg-new",
  createdAt: NOW,
  updatedAt: NOW,
  identifier: "pypi:requests",
  ecosystem: "PYPI",
  name: "requests",
  displayName: "requests",
  gitUrl: "https://github.com/psf/requests",
  subdirectory: null,
  tagPattern: null,
  defaultRef: null,
  lastUsedAt: null,
  SshKey: null,
  Repository: null,
};

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(proposalsRouter, { context });
}

function expectReason(code: string, reason?: string) {
  return (error: ORPCError<string, { reason?: string }>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
    return true;
  };
}

describe("proposalsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateRemoteUrl.mockResolvedValue({
      kind: "https",
      host: "github.com",
      port: 443,
      remoteUrl: "https://github.com/psf/requests",
      remoteKey: "https://github.com/psf/requests",
    });
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).list({})).rejects.toSatisfy(expectReason("UNAUTHORIZED"));
  });

  describe("list", () => {
    it("lists the caller's pending proposals with the pending count", async () => {
      db.packageProposal.findMany.mockResolvedValue([proposalRow()]);
      db.packageProposal.count.mockResolvedValue(1);
      const result = await client().list({});
      expect(db.packageProposal.findMany.mock.calls[0]?.[0].where).toEqual({
        AND: [{ ownerId: "user-a", status: "PENDING" }],
      });
      expect(db.packageProposal.count).toHaveBeenCalledWith({
        where: { ownerId: "user-a", status: "PENDING" },
      });
      expect(result.pendingCount).toBe(1);
      expect(result.items[0]).toMatchObject({ status: "pending", ecosystem: "pypi" });
      // The proposing connection's ids stay server-side; only the label shows.
      expect(result.items[0]).not.toHaveProperty("mcpAgentTokenId");
      expect(result.items[0]).not.toHaveProperty("mcpGrantId");
    });

    it("lists decided proposals as history", async () => {
      db.packageProposal.findMany.mockResolvedValue([]);
      db.packageProposal.count.mockResolvedValue(0);
      await client().list({ status: "decided" });
      expect(db.packageProposal.findMany.mock.calls[0]?.[0].where).toEqual({
        AND: [{ ownerId: "user-a", status: { in: ["APPROVED", "REJECTED"] } }],
      });
    });
  });

  describe("approve", () => {
    it("is NOT_FOUND for another user's proposal", async () => {
      db.packageProposal.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).approve({ id: "prop-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.packageProposal.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "prop-1" }, { ownerId: "user-b" }],
      });
      expect(db.package.create).not.toHaveBeenCalled();
    });

    it("claims the pending proposal and creates the package with the owner's edits", async () => {
      db.packageProposal.findFirst.mockResolvedValue(proposalRow());
      db.package.findFirst.mockResolvedValue(null);
      db.packageProposal.updateMany.mockResolvedValue({ count: 1 });
      db.package.create.mockResolvedValue(createdPackage);
      const result = await client().approve({ id: "prop-1", notes: "Session adapters" });
      expect(result).toMatchObject({ created: true, packageId: "pkg-new" });
      expect(db.packageProposal.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { id: "prop-1", ownerId: "user-a", status: "PENDING" },
        data: { status: "APPROVED", decidedAt: expect.any(Date) },
      });
      expect(db.package.create.mock.calls[0]?.[0].data).toMatchObject({
        ownerId: "user-a",
        identifier: "pypi:requests",
        ecosystem: "PYPI",
        notes: "Session adapters",
        gitUrl: "https://github.com/psf/requests",
      });
      expect(db.packageProposal.updateMany.mock.calls[1]?.[0]).toEqual({
        where: { id: "prop-1", ownerId: "user-a" },
        data: { packageId: "pkg-new" },
      });
    });

    it("spends a package-write point before the DNS check, and none for an existing package", async () => {
      db.packageProposal.findFirst.mockResolvedValue(proposalRow());
      db.package.findFirst.mockResolvedValue(null);
      budget.keys.length = 0;
      budget.errorQueue.push(new ORPCError("TOO_MANY_REQUESTS", { message: "slow down" }));
      await expect(client().approve({ id: "prop-1" })).rejects.toSatisfy(
        expectReason("TOO_MANY_REQUESTS"),
      );
      expect(budget.keys).toEqual(["rl:packages-write:user:user-a"]);
      expect(validateRemoteUrl).not.toHaveBeenCalled();
      expect(db.packageProposal.updateMany).not.toHaveBeenCalled();

      budget.keys.length = 0;
      db.package.findFirst.mockResolvedValue({ id: "pkg-existing" });
      db.packageProposal.updateMany.mockResolvedValue({ count: 1 });
      await client().approve({ id: "prop-1" });
      expect(budget.keys).toEqual([]);
    });

    it("creates nothing when a concurrent decision won the claim", async () => {
      db.packageProposal.findFirst.mockResolvedValue(proposalRow());
      db.package.findFirst.mockResolvedValue(null);
      db.packageProposal.updateMany.mockResolvedValue({ count: 0 });
      await expect(client().approve({ id: "prop-1" })).rejects.toSatisfy(
        expectReason("CONFLICT", "PROPOSAL_DECIDED"),
      );
      expect(db.package.create).not.toHaveBeenCalled();
    });

    it("approves against an existing package without creating one", async () => {
      db.packageProposal.findFirst.mockResolvedValue(proposalRow());
      db.package.findFirst.mockResolvedValue({ id: "pkg-existing" });
      db.packageProposal.updateMany.mockResolvedValue({ count: 1 });
      await expect(client().approve({ id: "prop-1" })).resolves.toEqual({
        created: false,
        packageId: "pkg-existing",
        package: null,
      });
      expect(db.package.findFirst).toHaveBeenCalledWith({
        where: { ownerId: "user-a", identifier: "pypi:requests" },
        select: { id: true },
      });
      expect(db.package.create).not.toHaveBeenCalled();
    });

    it("refuses a decided proposal and one without a git URL", async () => {
      db.packageProposal.findFirst.mockResolvedValue(proposalRow({ status: "REJECTED" }));
      await expect(client().approve({ id: "prop-1" })).rejects.toSatisfy(
        expectReason("CONFLICT", "PROPOSAL_DECIDED"),
      );
      db.packageProposal.findFirst.mockResolvedValue(proposalRow({ gitUrl: null }));
      db.package.findFirst.mockResolvedValue(null);
      await expect(client().approve({ id: "prop-1" })).rejects.toSatisfy(
        expectReason("BAD_REQUEST", "GIT_URL_REQUIRED"),
      );
    });
  });

  describe("reject", () => {
    it("records the reason on the caller's pending proposal", async () => {
      db.packageProposal.findFirst.mockResolvedValue({ id: "prop-1", status: "PENDING" });
      db.packageProposal.updateMany.mockResolvedValue({ count: 1 });
      await expect(client().reject({ id: "prop-1", reason: "Already vendored" })).resolves.toEqual({
        ok: true,
      });
      expect(db.packageProposal.updateMany).toHaveBeenCalledWith({
        where: { id: "prop-1", ownerId: "user-a", status: "PENDING" },
        data: {
          status: "REJECTED",
          decidedAt: expect.any(Date),
          rejectionReason: "Already vendored",
        },
      });
    });

    it("is NOT_FOUND for another user's proposal", async () => {
      db.packageProposal.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).reject({ id: "prop-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.packageProposal.updateMany).not.toHaveBeenCalled();
    });
  });
});

it("lets the owner approve an SSH proposal with a one-time key without persisting the credentials", async () => {
  vi.clearAllMocks();
  db.packageProposal.findFirst.mockResolvedValue(proposalRow());
  db.package.findFirst.mockResolvedValue(null);
  db.packageProposal.updateMany.mockResolvedValue({ count: 1 });
  db.package.create.mockResolvedValue(createdPackage);
  validateRemoteUrl.mockResolvedValue({ kind: "ssh", remoteUrl: "git@example.com:me/requests" });
  vi.mocked(repos.normalizeImportedPrivateKey).mockResolvedValue({
    privateKey: "NORMALIZED",
    publicKey: { keyType: "ssh-ed25519", publicKey: "public", fingerprint: "fp" },
  });
  vi.mocked(repos.createSnapshotRepository).mockResolvedValue({ id: "snapshot-repo" } as Awaited<
    ReturnType<typeof repos.createSnapshotRepository>
  >);
  await client().approve({
    id: "prop-1",
    gitUrl: "git@example.com:me/requests",
    oneTimeKey: { privateKey: "PASTED_SENTINEL" },
  });
  expect(db.package.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        isSnapshot: true,
        repositoryId: "snapshot-repo",
        ownerId: "user-a",
        sshKeyId: null,
      }),
    }),
  );
  expect(
    JSON.stringify([db.package.create.mock.calls, db.packageProposal.updateMany.mock.calls]),
  ).not.toContain("PASTED_SENTINEL");
  expect(budget.keys).toContain("rl:ssh-keys-write:user:user-a");
});
