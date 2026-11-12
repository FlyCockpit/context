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
  deleteCheckout: vi.fn(),
}));
vi.mock("@cockpit-context/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/jobs")>()),
  enqueueJob: vi.fn(async () => ({ id: "job-1", created: true })),
}));
const engine = { requestCheckoutSummary: vi.fn() };
const runConfig = { apiKey: "sk-test" as string | undefined, model: "test/model" };
vi.mock("@cockpit-context/runs", () => ({
  getRunEngine: () => engine,
  loadRunConfig: () => runConfig,
}));
vi.mock("@cockpit-context/runs/answer-reuse", () => ({ invalidateAnswersForRepository: vi.fn() }));
const { invalidateAnswersForRepository } = await import("@cockpit-context/runs/answer-reuse");

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { enqueueJob } = await import("@cockpit-context/jobs");
const { repositoriesRouter } = await import("./repositories");

const db = prisma as unknown as {
  package: { findFirst: MockInstance };
  checkout: { findMany: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  checkoutSummaryOverride: { upsert: MockInstance; deleteMany: MockInstance };
};
const deleteCheckout = repos.deleteCheckout as unknown as MockInstance;
const enqueue = enqueueJob as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");
const SHA = "b".repeat(40);

function checkoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "co-1",
    createdAt: NOW,
    sha: SHA,
    resolvedFrom: "tag:v1.0.0",
    status: "READY",
    diskBytes: 1234n,
    lastUsedAt: NOW,
    summary: "An overview",
    summaryStatus: "READY",
    summaryModel: "test/model",
    summaryGeneratedAt: NOW,
    SummaryOverrides: [],
    Leases: [],
    ...overrides,
  };
}

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(repositoriesRouter, { context });
}

function expectReason(code: string, reason?: string) {
  return (error: ORPCError<string, { reason?: string }>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
    return true;
  };
}

/** Checkouts are reached only through one of the caller's packages. */
function expectCheckoutOwnership(ownerId: string, checkoutId: string) {
  const where = db.package.findFirst.mock.calls[0]?.[0].where;
  expect(where).toEqual({
    AND: [{ Repository: { Checkouts: { some: { id: checkoutId } } } }, { ownerId }],
  });
}

describe("repositoriesRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runConfig.apiKey = "sk-test";
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).listCheckouts({ packageId: "pkg-1" })).rejects.toSatisfy(
      expectReason("UNAUTHORIZED"),
    );
  });

  describe("listCheckouts", () => {
    it("lists the checkouts of an own package's repository", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      db.checkout.findMany.mockResolvedValue([checkoutRow({ Leases: [{ id: "lease-1" }] })]);
      const result = await client().listCheckouts({ packageId: "pkg-1" });
      expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "pkg-1" }, { ownerId: "user-a" }],
      });
      expect(db.checkout.findMany.mock.calls[0]?.[0].where).toEqual({
        AND: [{ repositoryId: "repo-1" }],
      });
      expect(result.items).toEqual([
        {
          id: "co-1",
          createdAt: NOW,
          sha: SHA,
          resolvedFrom: "tag:v1.0.0",
          status: "ready",
          diskBytes: 1234,
          lastUsedAt: NOW,
          summary: "An overview",
          summaryStatus: "ready",
          summaryModel: "test/model",
          summaryGeneratedAt: NOW,
          summaryOverride: null,
          leased: true,
        },
      ]);
      // The repo map and errors stay server-side.
      const select = db.checkout.findMany.mock.calls[0]?.[0].select;
      expect(select).not.toHaveProperty("repoMap");
      expect(select).not.toHaveProperty("lastError");
    });

    it("selects only the viewer's own override", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-b", repositoryId: "repo-1" });
      db.checkout.findMany.mockResolvedValue([checkoutRow()]);
      await client(sessionContext({ id: "user-b" })).listCheckouts({ packageId: "pkg-b" });
      expect(db.checkout.findMany.mock.calls[0]?.[0].select.SummaryOverrides).toEqual({
        where: { userId: "user-b" },
        select: { body: true, updatedAt: true },
        take: 1,
      });
    });

    it("returns the generated summary to everyone and the override to its owner only", async () => {
      // user-a has an override; the projection is keyed on the session, so
      // user-b's query returns no override rows for that checkout.
      db.package.findFirst.mockResolvedValue({ id: "pkg-a", repositoryId: "repo-1" });
      db.checkout.findMany.mockResolvedValue([
        checkoutRow({ SummaryOverrides: [{ body: "A's own notes", updatedAt: NOW }] }),
      ]);
      const author = await client().listCheckouts({ packageId: "pkg-a" });
      expect(author.items[0]).toMatchObject({
        summary: "An overview",
        summaryStatus: "ready",
        summaryOverride: { body: "A's own notes", updatedAt: NOW },
      });
      expect(author.items[0]).not.toHaveProperty("SummaryOverrides");

      db.package.findFirst.mockResolvedValue({ id: "pkg-b", repositoryId: "repo-1" });
      db.checkout.findMany.mockResolvedValue([checkoutRow()]);
      const other = await client(sessionContext({ id: "user-b" })).listCheckouts({
        packageId: "pkg-b",
      });
      expect(other.items[0]).toMatchObject({ summary: "An overview", summaryOverride: null });
      expect(JSON.stringify(other)).not.toContain("A's own notes");
    });

    it("is empty for a package that was never cloned", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: null });
      await expect(client().listCheckouts({ packageId: "pkg-1" })).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      expect(db.checkout.findMany).not.toHaveBeenCalled();
    });

    it("is NOT_FOUND for another user's package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).listCheckouts({ packageId: "pkg-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.checkout.findMany).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("queues a deduplicated fetch of the package's repository", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      await expect(client().refresh({ packageId: "pkg-1" })).resolves.toEqual({
        queued: true,
        reason: null,
      });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: "repository.fetch" }),
        { repositoryId: "repo-1", mode: "default" },
        { dedupeKey: expect.stringMatching(/^repository\.fetch:repo-1:manual:\d+$/) },
      );
    });

    it("does nothing for a package that was never cloned", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: null });
      await expect(client().refresh({ packageId: "pkg-1" })).resolves.toEqual({
        queued: false,
        reason: "not_cloned",
      });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("is NOT_FOUND for another user's package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(client().refresh({ packageId: "pkg-x" })).rejects.toSatisfy(
        expectReason("NOT_FOUND"),
      );
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe("deleteCheckout", () => {
    it("deletes a checkout reachable through an own package", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      deleteCheckout.mockResolvedValue({ freedBytes: 99n });
      await expect(client().deleteCheckout({ checkoutId: "co-1" })).resolves.toEqual({
        freedBytes: 99,
      });
      expectCheckoutOwnership("user-a", "co-1");
      // Never forced: a leased checkout is refused by the git layer.
      expect(deleteCheckout).toHaveBeenCalledWith("co-1");
    });

    it("is NOT_FOUND when none of the caller's packages reaches it", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).deleteCheckout({ checkoutId: "co-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expectCheckoutOwnership("user-b", "co-1");
      expect(deleteCheckout).not.toHaveBeenCalled();
    });

    it("maps a leased checkout to CONFLICT", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      deleteCheckout.mockRejectedValue(new repos.RepoError("CHECKOUT_LEASED", "leased"));
      await expect(client().deleteCheckout({ checkoutId: "co-1" })).rejects.toSatisfy(
        expectReason("CONFLICT", "CHECKOUT_LEASED"),
      );
    });
  });

  describe("updateSummary", () => {
    it("upserts the caller's own override and never writes the checkout", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      db.checkoutSummaryOverride.upsert.mockResolvedValue({ id: "ov-1" });
      db.checkout.findUnique.mockResolvedValue(
        checkoutRow({ SummaryOverrides: [{ body: "Mine", updatedAt: NOW }] }),
      );
      const result = await client().updateSummary({ checkoutId: "co-1", summary: "  Mine  " });
      expectCheckoutOwnership("user-a", "co-1");
      expect(db.checkoutSummaryOverride.upsert).toHaveBeenCalledWith({
        where: { checkoutId_userId: { checkoutId: "co-1", userId: "user-a" } },
        create: { checkoutId: "co-1", userId: "user-a", body: "Mine" },
        update: { body: "Mine" },
        select: { id: true },
      });
      expect(db.checkout.updateMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        summary: "An overview",
        summaryStatus: "ready",
        summaryOverride: { body: "Mine", updatedAt: NOW },
      });
      expect(db.checkout.findUnique.mock.calls[0]?.[0].select.SummaryOverrides.where).toEqual({
        userId: "user-a",
      });
      // Only the caller's reused MCP answers on this repository are dropped.
      expect(invalidateAnswersForRepository).toHaveBeenCalledWith("repo-1", "user-a");
    });

    it("lets a second user on a shared checkout keep their own override", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-b", repositoryId: "repo-1" });
      db.checkoutSummaryOverride.upsert.mockResolvedValue({ id: "ov-2" });
      db.checkout.findUnique.mockResolvedValue(checkoutRow());
      await client(sessionContext({ id: "user-b" })).updateSummary({
        checkoutId: "co-1",
        summary: "B's notes",
      });
      // Keyed on user-b: user-a's row can be neither matched nor replaced.
      expect(db.checkoutSummaryOverride.upsert.mock.calls[0]?.[0].where).toEqual({
        checkoutId_userId: { checkoutId: "co-1", userId: "user-b" },
      });
    });

    it("is NOT_FOUND when the checkout vanished before the write", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      db.checkoutSummaryOverride.upsert.mockRejectedValue(
        Object.assign(new Error("fk"), { code: "P2003" }),
      );
      await expect(client().updateSummary({ checkoutId: "co-1", summary: "x" })).rejects.toSatisfy(
        expectReason("NOT_FOUND", "CHECKOUT_NOT_FOUND"),
      );
    });

    it("is NOT_FOUND through a foreign package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).updateSummary({
          checkoutId: "co-1",
          summary: "x",
        }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expectCheckoutOwnership("user-b", "co-1");
      expect(db.checkoutSummaryOverride.upsert).not.toHaveBeenCalled();
    });
  });

  describe("revertSummary", () => {
    it("deletes only the caller's own override", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-b", repositoryId: "repo-1" });
      db.checkoutSummaryOverride.deleteMany.mockResolvedValue({ count: 1 });
      db.checkout.findUnique.mockResolvedValue(checkoutRow());
      const result = await client(sessionContext({ id: "user-b" })).revertSummary({
        checkoutId: "co-1",
      });
      expectCheckoutOwnership("user-b", "co-1");
      expect(db.checkoutSummaryOverride.deleteMany).toHaveBeenCalledWith({
        where: { checkoutId: "co-1", userId: "user-b" },
      });
      expect(result).toMatchObject({ summary: "An overview", summaryOverride: null });
      expect(invalidateAnswersForRepository).toHaveBeenCalledWith("repo-1", "user-b");
    });

    it("is NOT_FOUND through a foreign package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).revertSummary({ checkoutId: "co-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.checkoutSummaryOverride.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("regenerateSummary", () => {
    it("asks the engine to regenerate under the caller, with no confirmation and no override writes", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      engine.requestCheckoutSummary.mockResolvedValue(true);
      await expect(client().regenerateSummary({ checkoutId: "co-1" })).resolves.toEqual({
        requested: true,
      });
      expect(engine.requestCheckoutSummary).toHaveBeenCalledWith({
        checkoutId: "co-1",
        ownerId: "user-a",
        packageId: "pkg-1",
        force: true,
      });
      expect(db.checkoutSummaryOverride.deleteMany).not.toHaveBeenCalled();
      expect(db.checkoutSummaryOverride.upsert).not.toHaveBeenCalled();
      expect(db.checkout.updateMany).not.toHaveBeenCalled();
    });

    it("regenerates for a second user of a shared checkout under that user", async () => {
      db.package.findFirst.mockResolvedValue({ id: "pkg-b", repositoryId: "repo-1" });
      engine.requestCheckoutSummary.mockResolvedValue(true);
      await expect(
        client(sessionContext({ id: "user-b" })).regenerateSummary({ checkoutId: "co-1" }),
      ).resolves.toEqual({ requested: true });
      expect(engine.requestCheckoutSummary).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "user-b", packageId: "pkg-b" }),
      );
    });

    it("refuses when no model is configured", async () => {
      runConfig.apiKey = undefined;
      db.package.findFirst.mockResolvedValue({ id: "pkg-1", repositoryId: "repo-1" });
      await expect(client().regenerateSummary({ checkoutId: "co-1" })).rejects.toSatisfy(
        expectReason("SERVICE_UNAVAILABLE", "MODEL_NOT_CONFIGURED"),
      );
      expect(engine.requestCheckoutSummary).not.toHaveBeenCalled();
    });

    it("is NOT_FOUND through a foreign package", async () => {
      db.package.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).regenerateSummary({ checkoutId: "co-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(engine.requestCheckoutSummary).not.toHaveBeenCalled();
    });
  });
});

it("never enqueues a refresh job for a snapshot", async () => {
  vi.clearAllMocks();
  db.package.findFirst.mockResolvedValue({
    id: "pkg-snapshot",
    repositoryId: "repo-snapshot",
    isSnapshot: true,
  });
  await expect(client().refresh({ packageId: "pkg-snapshot" })).rejects.toMatchObject({
    data: { reason: "PACKAGE_SNAPSHOT_REF_MISSING" },
  });
  expect(enqueueJob).not.toHaveBeenCalled();
});
