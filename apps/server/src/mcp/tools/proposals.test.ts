import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { McpIdentity } from "../credentials";

const DEFAULT_MAX_PENDING = 100;

const { lookupRegistry, api, envMock } = vi.hoisted(() => ({
  envMock: { COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER: 100 },
  lookupRegistry: vi.fn(),
  api: {
    consumePackageWriteBudget: vi.fn(),
    consumeRegistryLookupBudget: vi.fn(),
    validatePackageSource: vi.fn(),
    insertPackage: vi.fn(),
  },
}));

vi.mock("@cockpit-context/env/server", () => ({ env: envMock }));
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/repos")>()),
  lookupRegistry: (...args: unknown[]) => lookupRegistry(...args),
}));
vi.mock("@cockpit-context/api/lib/packages", () => ({
  ...api,
  ecosystemSchema: z.enum(["npm", "pypi", "cargo", "go", "git"]),
  lower: (value: string) => value.toLowerCase(),
  normalizeNameOrThrow: (_ecosystem: string, name: string) => name.toLowerCase(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const { runGetProposal, runProposeDependency } = await import("./proposals");

const db = prisma as unknown as {
  package: { findFirst: MockInstance };
  packageProposal: { findFirst: MockInstance; create: MockInstance; count: MockInstance };
};

function identity(overrides: Partial<McpIdentity> = {}): McpIdentity {
  return {
    userId: "user-a",
    credential: { kind: "oauth", grantId: "grant-1", clientId: "client-1" },
    label: "Claude Code",
    allowPropose: true,
    autoApprove: false,
    ...overrides,
  };
}

const INPUT = { ecosystem: "npm" as const, name: "left-pad", reason: "Used in utils." };

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    status: "PENDING",
    identifier: "npm:left-pad",
    rejectionReason: null,
    packageId: null,
    ...overrides,
  };
}

describe("propose_dependency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER = DEFAULT_MAX_PENDING;
    db.package.findFirst.mockResolvedValue(null);
    db.packageProposal.findFirst.mockResolvedValue(null);
    db.packageProposal.count.mockResolvedValue(0);
    api.consumeRegistryLookupBudget.mockResolvedValue(undefined);
    db.packageProposal.create.mockImplementation(async (args: { data: Record<string, unknown> }) =>
      proposalRow({
        status: args.data.status ?? "PENDING",
        packageId: args.data.packageId ?? null,
      }),
    );
    lookupRegistry.mockResolvedValue({
      status: "found",
      suggestion: {
        gitUrl: "https://github.com/left-pad/left-pad",
        displayName: "left-pad",
        subdirectory: null,
      },
    });
  });

  it("says when the package already exists", async () => {
    db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
    await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
      status: "exists",
      identifier: "npm:left-pad",
    });
    expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({
      ownerId: "user-a",
      identifier: "npm:left-pad",
    });
    expect(db.packageProposal.create).not.toHaveBeenCalled();
  });

  it("returns an existing pending proposal instead of a duplicate", async () => {
    db.packageProposal.findFirst.mockResolvedValue(proposalRow());
    await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
      proposal_id: "prop-1",
      status: "pending",
    });
    expect(db.packageProposal.create).not.toHaveBeenCalled();
  });

  it("creates a pending proposal with the registry's suggestions and the connection", async () => {
    const result = await runProposeDependency(INPUT, identity());
    expect(result).toMatchObject({ status: "pending" });
    expect(db.packageProposal.create.mock.calls[0]?.[0].data).toMatchObject({
      ownerId: "user-a",
      identifier: "npm:left-pad",
      gitUrl: "https://github.com/left-pad/left-pad",
      reason: "Used in utils.",
      mcpGrantId: "grant-1",
      connectionLabel: "Claude Code",
    });
    expect(api.insertPackage).not.toHaveBeenCalled();
  });

  it("creates the package at once for an auto-approving connection", async () => {
    api.validatePackageSource.mockResolvedValue({
      gitUrl: "https://github.com/left-pad/left-pad",
      sshKeyId: null,
    });
    api.insertPackage.mockResolvedValue({ id: "pkg-9", identifier: "npm:left-pad" });
    const result = await runProposeDependency(INPUT, identity({ autoApprove: true }));
    expect(result).toMatchObject({ status: "approved", identifier: "npm:left-pad" });
    expect(api.insertPackage.mock.calls[0]?.[1]).toBe("user-a");
    expect(db.packageProposal.create.mock.calls[0]?.[0].data).toMatchObject({
      status: "APPROVED",
      packageId: "pkg-9",
    });
  });

  it.each([
    ["https://github.com/attacker/left-pad", "pending"],
    ["https://github.com/left-pad/left-pad.git/", "approved"],
    ["https://github.com/left-pad/left-pad", "approved"],
  ])("checks agent URL provenance: %s → %s", async (git_url, status) => {
    api.validatePackageSource.mockResolvedValue({ gitUrl: git_url, sshKeyId: null });
    api.insertPackage.mockResolvedValue({ id: "pkg-9", identifier: "npm:left-pad" });
    const result = await runProposeDependency(
      { ...INPUT, git_url },
      identity({ autoApprove: true }),
    );
    expect(result.status).toBe(status);
    expect(db.packageProposal.create.mock.calls[0]?.[0].data.gitUrl).toBe(git_url);
    if (status === "pending") expect(api.insertPackage).not.toHaveBeenCalled();
  });

  it.each([
    ["owner/repo", "https://github.com/owner/repo", "pending"],
    ["github.com/owner/repo", "https://evil.example/owner/repo", "pending"],
    ["github.com/owner/repo", "https://github.com/owner/repo.git", "approved"],
  ])("requires a corroborated host/path for git %s", async (name, git_url, status) => {
    api.validatePackageSource.mockResolvedValue({ gitUrl: git_url, sshKeyId: null });
    api.insertPackage.mockResolvedValue({ id: "pkg-9", identifier: `git:${name}` });
    const result = await runProposeDependency(
      { ecosystem: "git", name, git_url, reason: "r" },
      identity({ autoApprove: true }),
    );
    expect(result.status).toBe(status);
    expect(lookupRegistry).not.toHaveBeenCalled();
  });

  it("requires review when a supplied URL cannot be corroborated by the registry", async () => {
    lookupRegistry.mockResolvedValue({ status: "not_found" });
    const result = await runProposeDependency(
      { ...INPUT, git_url: "https://github.com/left-pad/left-pad" },
      identity({ autoApprove: true }),
    );
    expect(result.status).toBe("pending");
    expect(api.insertPackage).not.toHaveBeenCalled();
  });

  it("never auto-approves an SSH source", async () => {
    const result = await runProposeDependency(
      { ...INPUT, git_url: "git@github.com:me/private.git" },
      identity({ autoApprove: true }),
    );
    expect(result).toMatchObject({ status: "pending" });
    expect(api.insertPackage).not.toHaveBeenCalled();
  });

  it("leaves the proposal pending when auto-approval is refused", async () => {
    api.validatePackageSource.mockRejectedValue(new Error("PRIVATE_ADDRESS"));
    const result = await runProposeDependency(INPUT, identity({ autoApprove: true }));
    expect(result).toMatchObject({ status: "pending" });
  });

  it("refuses an invalid package name", async () => {
    await expect(
      runProposeDependency({ ...INPUT, name: "not a name!!" }, identity()),
    ).rejects.toMatchObject({ code: "INVALID_PACKAGE_NAME" });
  });

  it("charges the user's registry-lookup budget, the web's bucket", async () => {
    await runProposeDependency(INPUT, identity());
    expect(api.consumeRegistryLookupBudget).toHaveBeenCalledExactlyOnceWith("user:user-a");
    expect(lookupRegistry).toHaveBeenCalledOnce();
  });

  it("creates the proposal without a suggestion when the registry budget is spent", async () => {
    api.consumeRegistryLookupBudget.mockRejectedValue(new Error("TOO_MANY_REQUESTS"));
    const result = await runProposeDependency(INPUT, identity());
    expect(result).toMatchObject({ status: "pending" });
    expect(lookupRegistry).not.toHaveBeenCalled();
    expect(db.packageProposal.create.mock.calls[0]?.[0].data).toMatchObject({
      identifier: "npm:left-pad",
      gitUrl: null,
      displayName: null,
      subdirectory: null,
    });
  });

  it("neither charges nor looks up the registry for a git package", async () => {
    await runProposeDependency(
      { ecosystem: "git", name: "me/repo", git_url: "https://github.com/me/repo", reason: "r" },
      identity(),
    );
    expect(api.consumeRegistryLookupBudget).not.toHaveBeenCalled();
    expect(lookupRegistry).not.toHaveBeenCalled();
  });

  it("refuses a new proposal once the user has the maximum pending", async () => {
    db.packageProposal.count.mockResolvedValue(DEFAULT_MAX_PENDING);
    await expect(runProposeDependency(INPUT, identity())).rejects.toMatchObject({
      name: "McpToolError",
      code: "PROPOSAL_LIMIT",
      details: { max_pending: DEFAULT_MAX_PENDING },
    });
    expect(db.packageProposal.count.mock.calls[0]?.[0]).toEqual({
      where: { ownerId: "user-a", status: "PENDING" },
    });
    expect(api.consumeRegistryLookupBudget).not.toHaveBeenCalled();
    expect(db.packageProposal.create).not.toHaveBeenCalled();
  });

  it("creates a proposal just under the cap", async () => {
    db.packageProposal.count.mockResolvedValue(DEFAULT_MAX_PENDING - 1);
    await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("reads the cap from COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER on each call", async () => {
    envMock.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER = 5_000;
    try {
      db.packageProposal.count.mockResolvedValue(DEFAULT_MAX_PENDING);
      await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
        status: "pending",
      });
      db.packageProposal.count.mockResolvedValue(5_000);
      await expect(runProposeDependency(INPUT, identity())).rejects.toMatchObject({
        code: "PROPOSAL_LIMIT",
        details: { max_pending: 5_000 },
      });
    } finally {
      envMock.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER = DEFAULT_MAX_PENDING;
    }
  });

  it("still returns an existing pending proposal at the cap", async () => {
    db.packageProposal.count.mockResolvedValue(DEFAULT_MAX_PENDING);
    db.packageProposal.findFirst.mockResolvedValue(proposalRow());
    await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
      proposal_id: "prop-1",
      status: "pending",
    });
  });

  it("serializes concurrent proposals of one identifier: the second gets the first's", async () => {
    // A store that sees its own writes, and a registry lookup that stalls
    // until released, so both calls are in flight at once.
    const created: ReturnType<typeof proposalRow>[] = [];
    db.packageProposal.findFirst.mockImplementation(async () => created[0] ?? null);
    db.packageProposal.create.mockImplementation(async () => {
      const row = proposalRow({ id: `prop-${created.length + 1}` });
      created.push(row);
      return row;
    });
    let releaseLookup: () => void = () => {};
    lookupRegistry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLookup = () => resolve({ status: "not_found" });
        }),
    );
    const first = runProposeDependency(INPUT, identity());
    const second = runProposeDependency(INPUT, identity());
    await vi.waitFor(() => expect(lookupRegistry).toHaveBeenCalledOnce());
    releaseLookup();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => "proposal_id" in result && result.proposal_id)).toEqual([
      "prop-1",
      "prop-1",
    ]);
    expect(db.packageProposal.create).toHaveBeenCalledOnce();
    expect(lookupRegistry).toHaveBeenCalledOnce();
  });

  it("enforces the pending cap across concurrent different identifiers", async () => {
    envMock.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER = 1;
    let count = 0;
    db.packageProposal.count.mockImplementation(async () => count);
    db.packageProposal.create.mockImplementation(async () => {
      count += 1;
      return proposalRow();
    });
    let releaseLookup: () => void = () => {};
    lookupRegistry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLookup = () => resolve({ status: "not_found" });
        }),
    );
    const first = runProposeDependency(INPUT, identity());
    await vi.waitFor(() => expect(lookupRegistry).toHaveBeenCalledOnce());
    const second = runProposeDependency({ ...INPUT, name: "right-pad" }, identity());
    const secondRejected = expect(second).rejects.toMatchObject({ code: "PROPOSAL_LIMIT" });
    releaseLookup();
    await first;
    await secondRejected;
    expect(db.packageProposal.create).toHaveBeenCalledOnce();
    envMock.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER = DEFAULT_MAX_PENDING;
  });

  it("releases the lock when a call fails", async () => {
    db.package.findFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(runProposeDependency(INPUT, identity())).rejects.toThrow("db down");
    await expect(runProposeDependency(INPUT, identity())).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("get_proposal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is owner-scoped and returns the rejection reason", async () => {
    db.packageProposal.findFirst.mockResolvedValue(
      proposalRow({ status: "REJECTED", rejectionReason: "Not needed." }),
    );
    await expect(runGetProposal({ proposal_id: "prop-1" }, "user-a")).resolves.toMatchObject({
      status: "rejected",
      rejection_reason: "Not needed.",
    });
    expect(db.packageProposal.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: "prop-1",
      ownerId: "user-a",
    });
    db.packageProposal.findFirst.mockResolvedValue(null);
    await expect(runGetProposal({ proposal_id: "prop-1" }, "user-b")).rejects.toMatchObject({
      code: "PROPOSAL_NOT_FOUND",
    });
  });
});
