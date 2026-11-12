import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext, anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@cockpit-context/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
vi.mock("@cockpit-context/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/repos")>()),
  deleteCheckout: vi.fn(),
  deleteRepository: vi.fn(),
  totalStorageBytes: vi.fn(async () => 5_000n),
  maxStorageBytes: vi.fn(() => 20_000_000_000n),
}));
vi.mock("@cockpit-context/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/jobs")>()),
  enqueueJob: vi.fn(async () => ({ id: "job-prune", created: true })),
}));

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { enqueueJob } = await import("@cockpit-context/jobs");
const { adminStorageRouter } = await import("./admin-storage");

const db = prisma as unknown as { repository: { findMany: MockInstance } };
const deleteCheckout = repos.deleteCheckout as unknown as MockInstance;
const deleteRepository = repos.deleteRepository as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");

function repositoryRow(visibility: "PUBLIC" | "PRIVATE") {
  return {
    id: `repo-${visibility}`,
    createdAt: NOW,
    remoteUrl: visibility === "PUBLIC" ? "https://github.com/a/b" : "git@git.example.com:me/x",
    visibility,
    status: "READY",
    diskBytes: 100n,
    lastUsedAt: NOW,
    lastFetchedAt: NOW,
    Owner: visibility === "PRIVATE" ? { email: "owner@example.com" } : null,
    _count: { Checkouts: 1, Packages: 2 },
    Checkouts: [
      {
        id: "co-1",
        sha: "a".repeat(40),
        resolvedFrom: "branch:main",
        status: "READY",
        diskBytes: 50n,
        lastUsedAt: NOW,
        Leases: [{ id: "lease" }],
      },
    ],
  };
}

function client(context = adminContext()) {
  return createRouterClient(adminStorageRouter, { context });
}

const hidden = (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND";

describe("adminStorageRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repository.aggregate).mockResolvedValue({
      _sum: { diskBytes: 500n },
    } as Awaited<ReturnType<typeof prisma.repository.aggregate>>);
  });

  it("is 404-hidden from anonymous callers and regular users", async () => {
    for (const context of [anonymousContext, sessionContext({ id: "user-a" })]) {
      await expect(client(context).list({})).rejects.toSatisfy(hidden);
      await expect(client(context).delete({ kind: "checkout", id: "co-1" })).rejects.toSatisfy(
        hidden,
      );
      await expect(client(context).prune()).rejects.toSatisfy(hidden);
    }
    expect(db.repository.findMany).not.toHaveBeenCalled();
    expect(deleteCheckout).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("lists every repository with owner email for private clones only", async () => {
    db.repository.findMany.mockResolvedValue([repositoryRow("PUBLIC"), repositoryRow("PRIVATE")]);
    const result = await client().list({});
    expect(result.snapshotBytes).toBe(500);
    expect(result.totalBytes).toBe(5_000);
    expect(result.capBytes).toBe(20_000_000_000);
    expect(result.items.map((item) => item.ownerEmail)).toEqual([null, "owner@example.com"]);
    expect(result.items[0]?.checkouts[0]).toMatchObject({ leased: true, diskBytes: 50 });
    // Nothing of anyone's packages, keys or conversations is selected.
    const select = db.repository.findMany.mock.calls[0]?.[0].select;
    expect(Object.keys(select).sort()).toEqual(
      [
        "Checkouts",
        "Owner",
        "_count",
        "createdAt",
        "diskBytes",
        "id",
        "isSnapshot",
        "lastFetchedAt",
        "lastUsedAt",
        "remoteUrl",
        "status",
        "visibility",
      ].sort(),
    );
    expect(select.Owner).toEqual({ select: { email: true } });
    expect(select.Checkouts.select).not.toHaveProperty("summary");
    expect(select.Checkouts.select).not.toHaveProperty("repoMap");
  });

  it("deletes a checkout or a clone, forcing only when asked", async () => {
    deleteCheckout.mockResolvedValue({ freedBytes: 10n });
    deleteRepository.mockResolvedValue({ freedBytes: 20n });
    await expect(client().delete({ kind: "checkout", id: "co-1" })).resolves.toEqual({
      freedBytes: 10,
    });
    expect(deleteCheckout).toHaveBeenCalledWith("co-1", { force: false });
    await client().delete({ kind: "repository", id: "repo-1", force: true });
    expect(deleteRepository).toHaveBeenCalledWith("repo-1", { force: true });
  });

  it("maps a leased checkout to CONFLICT", async () => {
    deleteCheckout.mockRejectedValue(new repos.RepoError("CHECKOUT_LEASED", "leased"));
    await expect(client().delete({ kind: "checkout", id: "co-1" })).rejects.toSatisfy(
      (error: ORPCError<string, { reason: string }>) =>
        error.code === "CONFLICT" && error.data.reason === "CHECKOUT_LEASED",
    );
  });

  it("queues a measuring prune pass", async () => {
    await expect(client().prune()).resolves.toEqual({ jobId: "job-prune" });
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ type: "storage.prune" }), {
      reason: "manual",
      measure: true,
    });
  });
});
