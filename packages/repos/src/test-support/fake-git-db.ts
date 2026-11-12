import type { MockInstance } from "vitest";

/**
 * Test-only in-memory stand-in for the repository/checkout rows, wired onto a
 * `mockDeep()` Prisma client so the git-layer services can run end to end
 * against a real fixture repository without a database.
 */

export type FakeRepositoryRow = {
  id: string;
  createdAt: Date;
  remoteUrl: string;
  remoteKey: string;
  visibility: "PUBLIC" | "PRIVATE";
  ownerId: string | null;
  sshKeyId: string | null;
  isSnapshot: boolean;
  status: "PENDING" | "CLONING" | "READY" | "FAILED";
  lastError: string | null;
  defaultBranch: string | null;
  diskBytes: bigint;
  lastFetchedAt: Date | null;
  lastUsedAt: Date | null;
};

export type FakeCheckoutRow = {
  id: string;
  createdAt: Date;
  repositoryId: string;
  sha: string;
  resolvedFrom: string | null;
  status: "PENDING" | "READY" | "FAILED";
  lastError: string | null;
  diskBytes: bigint;
  lastUsedAt: Date | null;
  summaryStatus: "NONE";
};

type Delegate = Record<string, MockInstance>;

export type FakeDb = {
  repository: Delegate;
  checkout: Delegate;
  checkoutLease: Delegate;
  package: Delegate;
  sshKey: Delegate;
};

function makeRepositoryRow(overrides: Partial<FakeRepositoryRow> = {}): FakeRepositoryRow {
  return {
    id: "repo0000000001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    remoteUrl: "https://example.com/o/r",
    remoteKey: "https://example.com/o/r",
    visibility: "PUBLIC",
    ownerId: null,
    sshKeyId: null,
    isSnapshot: false,
    status: "PENDING",
    lastError: null,
    defaultBranch: null,
    diskBytes: 0n,
    lastFetchedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/** Wire find/update/upsert/delete on the repository and checkout delegates to in-memory maps. */
export function installFakeRows(db: FakeDb) {
  const repositories = new Map<string, FakeRepositoryRow>();
  const checkouts = new Map<string, FakeCheckoutRow>();
  let nextCheckout = 1;

  db.repository.create?.mockImplementation(async (args: { data: Partial<FakeRepositoryRow> }) => {
    const row = makeRepositoryRow({
      ...args.data,
      id: `repo${String(repositories.size + 1).padStart(10, "0")}`,
    });
    repositories.set(row.id, row);
    return { ...row };
  });
  db.repository.findFirst?.mockImplementation(
    async (args: { where: Partial<FakeRepositoryRow> }) => {
      const row = [...repositories.values()].find((row) =>
        Object.entries(args.where).every(([key, value]) => Reflect.get(row, key) === value),
      );
      return row ? { ...row } : null;
    },
  );
  db.repository.findUnique?.mockImplementation(async (args: { where: { id: string } }) => {
    const row = repositories.get(args.where.id);
    return row ? { ...row } : null;
  });
  db.repository.update?.mockImplementation(
    async (args: { where: { id: string }; data: Partial<FakeRepositoryRow> }) => {
      const row = repositories.get(args.where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, args.data);
      return { ...row };
    },
  );
  db.repository.upsert?.mockImplementation(
    async (args: { create: Partial<FakeRepositoryRow> & { ownerScope?: string } }) => {
      const existing = [...repositories.values()].find(
        (row) =>
          row.remoteKey === args.create.remoteKey &&
          (row.ownerId ?? "") === (args.create.ownerScope ?? ""),
      );
      if (existing) return { ...existing };
      const { ownerScope: _scope, ...create } = args.create;
      const row = makeRepositoryRow({
        ...create,
        id: `repo${String(repositories.size + 1).padStart(10, "0")}`,
      });
      repositories.set(row.id, row);
      return { ...row };
    },
  );
  db.repository.delete?.mockImplementation(async (args: { where: { id: string } }) => {
    repositories.delete(args.where.id);
    return { id: args.where.id };
  });

  db.checkout.findUnique?.mockImplementation(async (args: { where: { id: string } }) => {
    const row = checkouts.get(args.where.id);
    return row ? { ...row } : null;
  });
  db.checkout.upsert?.mockImplementation(
    async (args: {
      where: { repositoryId_sha: { repositoryId: string; sha: string } };
      create: { repositoryId: string; sha: string; resolvedFrom: string | null };
    }) => {
      const key = args.where.repositoryId_sha;
      const existing = [...checkouts.values()].find(
        (row) => row.repositoryId === key.repositoryId && row.sha === key.sha,
      );
      if (existing) return { ...existing };
      const row: FakeCheckoutRow = {
        id: `chk${String(nextCheckout++).padStart(10, "0")}`,
        createdAt: new Date(),
        repositoryId: args.create.repositoryId,
        sha: args.create.sha,
        resolvedFrom: args.create.resolvedFrom,
        status: "PENDING",
        lastError: null,
        diskBytes: 0n,
        lastUsedAt: null,
        summaryStatus: "NONE",
      };
      checkouts.set(row.id, row);
      return { ...row };
    },
  );
  db.checkout.update?.mockImplementation(
    async (args: { where: { id: string }; data: Partial<FakeCheckoutRow> }) => {
      const row = checkouts.get(args.where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, args.data);
      return { ...row };
    },
  );
  db.checkout.findMany?.mockImplementation(async (args: { where: { repositoryId: string } }) =>
    [...checkouts.values()].filter((row) => row.repositoryId === args.where.repositoryId),
  );
  db.checkout.delete?.mockImplementation(async (args: { where: { id: string } }) => {
    checkouts.delete(args.where.id);
    return { id: args.where.id };
  });
  db.checkout.aggregate?.mockImplementation(async () => ({ _sum: { diskBytes: 0n } }));
  db.checkoutLease.count?.mockResolvedValue(0);
  db.package.updateMany?.mockResolvedValue({ count: 1 });

  return { repositories, checkouts };
}
