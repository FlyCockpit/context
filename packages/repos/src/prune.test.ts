import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepoError } from "./errors";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

/**
 * An in-memory disk: repositories and checkouts with sizes, last use and
 * leases. The candidate queries are answered from it (honoring the where
 * clauses prune.ts sends), and the delete services remove rows from it — the
 * fake filesystem size function the spec asks for.
 */
type Checkout = {
  id: string;
  repositoryId: string;
  status: "PENDING" | "READY" | "FAILED";
  bytes: bigint;
  lastUsedAt: Date | null;
  leaseUntil?: Date;
};
type Repository = {
  id: string;
  status: "READY" | "CLONING";
  bytes: bigint;
  lastUsedAt: Date | null;
  packages: number;
  isSnapshot?: boolean;
};

const disk = vi.hoisted(() => ({
  repositories: new Map<string, Repository>(),
  checkouts: new Map<string, Checkout>(),
  now: new Date("2026-10-24T12:00:00Z"),
  measured: [] as string[],
  removalOrder: [] as string[],
}));

const leased = (checkout: Checkout) =>
  checkout.leaseUntil !== undefined && checkout.leaseUntil > disk.now;

vi.mock("./config", () => ({ maxStorageBytes: () => 1_000n }));
vi.mock("./checkouts", () => ({
  deleteCheckout: vi.fn(async (id: string) => {
    const row = disk.checkouts.get(id);
    if (!row) throw new RepoError("CHECKOUT_NOT_FOUND", "gone");
    if (leased(row)) throw new RepoError("CHECKOUT_LEASED", "leased");
    disk.checkouts.delete(id);
    disk.removalOrder.push(`checkout:${id}`);
    return { freedBytes: row.bytes };
  }),
}));
vi.mock("./repositories", () => ({
  totalStorageBytes: vi.fn(async () => {
    let sum = 0n;
    for (const repo of disk.repositories.values()) sum += repo.bytes;
    for (const checkout of disk.checkouts.values()) sum += checkout.bytes;
    return sum;
  }),
  measure: vi.fn(async (id: string) => {
    disk.measured.push(id);
    return { repositoryBytes: 0n, checkouts: [], totalBytes: 0n };
  }),
  deleteRepository: vi.fn(async (id: string) => {
    const repo = disk.repositories.get(id);
    if (!repo) throw new RepoError("REPOSITORY_NOT_FOUND", "gone");
    const children = [...disk.checkouts.values()].filter((row) => row.repositoryId === id);
    if (children.some(leased)) throw new RepoError("CHECKOUT_LEASED", "leased");
    let freed = repo.bytes;
    for (const child of children) {
      freed += child.bytes;
      disk.checkouts.delete(child.id);
    }
    disk.repositories.delete(id);
    disk.removalOrder.push(`repository:${id}`);
    return { freedBytes: freed };
  }),
}));

const { default: prisma } = await import("@cockpit-context/db");
const { pruneStorage } = await import("./prune");

type Where = Record<string, unknown> & { id?: { notIn?: string[]; gt?: string } };
const byLru = <T extends { id: string; lastUsedAt: Date | null }>(rows: T[]) =>
  rows.sort((a, b) => {
    const at = a.lastUsedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bt = b.lastUsedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return at - bt || a.id.localeCompare(b.id);
  });

const db = prisma as unknown as {
  checkout: { findMany: ReturnType<typeof vi.fn> };
  repository: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  disk.repositories.clear();
  disk.checkouts.clear();
  disk.measured = [];
  disk.removalOrder = [];
  db.checkout.findMany.mockImplementation(async (args: { where: Where; take: number }) => {
    const skip = new Set(args.where.id?.notIn ?? []);
    return byLru(
      [...disk.checkouts.values()].filter(
        (row) => !skip.has(row.id) && row.status !== "PENDING" && !leased(row),
      ),
    )
      .slice(0, args.take)
      .map((row) => ({ id: row.id }));
  });
  db.repository.findMany.mockImplementation(async (args: { where: Where; take: number }) => {
    const where = args.where;
    if (where.id?.gt !== undefined || Object.keys(where).length === 0) {
      // measureAll's keyset scan.
      const after = where.id?.gt ?? "";
      return [...disk.repositories.keys()]
        .sort()
        .filter((id) => id > after)
        .slice(0, args.take)
        .map((id) => ({ id }));
    }
    const skip = new Set(where.id?.notIn ?? []);
    const orphansOnly = "Packages" in where;
    return byLru(
      [...disk.repositories.values()].filter((repo) => {
        if (
          skip.has(repo.id) ||
          repo.status === "CLONING" ||
          (where.isSnapshot === false && repo.isSnapshot)
        )
          return false;
        const children = [...disk.checkouts.values()].filter((row) => row.repositoryId === repo.id);
        if (orphansOnly) return children.length === 0 && repo.packages === 0;
        return !children.some(leased);
      }),
    )
      .slice(0, args.take)
      .map((repo) => ({ id: repo.id }));
  });
});

const at = (minutes: number) => new Date(disk.now.getTime() - minutes * 60_000);
function addRepo(id: string, bytes: bigint, lastUsed: number | null, packages = 1) {
  disk.repositories.set(id, {
    id,
    status: "READY",
    bytes,
    lastUsedAt: lastUsed === null ? null : at(lastUsed),
    packages,
  });
}
function addCheckout(
  id: string,
  repositoryId: string,
  bytes: bigint,
  lastUsed: number | null,
  extra: Partial<Checkout> = {},
) {
  disk.checkouts.set(id, {
    id,
    repositoryId,
    status: "READY",
    bytes,
    lastUsedAt: lastUsed === null ? null : at(lastUsed),
    ...extra,
  });
}

const deps = { now: () => disk.now };

describe("pruneStorage", () => {
  it("does nothing while usage is under the cap", async () => {
    addRepo("r1", 400n, 10);
    addCheckout("c1", "r1", 500n, 10);
    const result = await pruneStorage({}, deps);
    expect(result.beforeBytes).toBe(900n);
    expect(result.evictedCheckouts).toEqual([]);
    expect(disk.removalOrder).toEqual([]);
  });

  it("evicts least recently used unleased checkouts until under 90 % of the cap", async () => {
    addRepo("r1", 100n, 1);
    addCheckout("old", "r1", 300n, 300);
    addCheckout("mid", "r1", 300n, 200);
    addCheckout("new", "r1", 300n, 1);
    // 100 + 900 is exactly the cap; one more never-used row pushes it over.
    addCheckout("never", "r1", 100n, null, { status: "FAILED" });
    const result = await pruneStorage({}, deps);
    // 1 100 → target 900: never-used first (nulls first), then the oldest.
    expect(result.evictedCheckouts).toEqual(["never", "old"]);
    expect(result.afterBytes).toBe(700n);
    expect(disk.checkouts.has("mid")).toBe(true);
  });

  it("never evicts a leased checkout or one still being created", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("leased", "r1", 900n, 500, { leaseUntil: at(-10) });
    addCheckout("pending", "r1", 0n, null, { status: "PENDING" });
    addCheckout("free", "r1", 300n, 5);
    const result = await pruneStorage({}, deps);
    expect(result.evictedCheckouts).toEqual(["free"]);
    expect(disk.checkouts.has("leased")).toBe(true);
    expect(disk.checkouts.has("pending")).toBe(true);
  });

  it("treats an expired lease as no lease", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("stale", "r1", 1_200n, 500, { leaseUntil: at(5) });
    const result = await pruneStorage({}, deps);
    expect(result.evictedCheckouts).toEqual(["stale"]);
  });

  it("skips a checkout leased between the query and the delete", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("racy", "r1", 600n, 500);
    addCheckout("next", "r1", 600n, 400);
    const { deleteCheckout } = await import("./checkouts");
    vi.mocked(deleteCheckout).mockImplementationOnce(async () => {
      throw new RepoError("CHECKOUT_LEASED", "leased just now");
    });
    const result = await pruneStorage({}, deps);
    expect(result.evictedCheckouts).toEqual(["next"]);
    expect(disk.checkouts.has("racy")).toBe(true);
  });

  it("then removes orphan clones, then referenced-but-unused clones, oldest first", async () => {
    addRepo("busy", 500n, 600);
    addCheckout("busy-c", "busy", 100n, 600, { leaseUntil: at(-30) });
    addRepo("referenced-old", 400n, 500, 1);
    addRepo("referenced-new", 400n, 100, 1);
    addRepo("orphan", 300n, 50, 0);
    // 1 700 → target 900: only the leased checkout and its clone (600) survive.
    const result = await pruneStorage({}, deps);
    expect(disk.removalOrder).toEqual([
      "repository:orphan",
      "repository:referenced-old",
      "repository:referenced-new",
    ]);
    expect(result.evictedRepositories).toEqual(["orphan", "referenced-old", "referenced-new"]);
    expect(result.afterBytes).toBe(600n);
    // The leased checkout's repository survives even though it is the oldest.
    expect(disk.repositories.has("busy")).toBe(true);
  });

  it("re-measures every repository first when asked", async () => {
    addRepo("a", 1n, 1);
    addRepo("b", 1n, 1);
    const result = await pruneStorage({ measure: true }, deps);
    expect(disk.measured.sort()).toEqual(["a", "b"]);
    expect(result.measured).toBe(2);
  });

  it("honors an explicit cap", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("c1", "r1", 50n, 1);
    const result = await pruneStorage({ capBytes: 10n }, deps);
    expect(result.evictedCheckouts).toEqual(["c1"]);
    expect(result.targetBytes).toBe(9n);
  });
});

describe("pruneStorage coalescing", () => {
  /** Hold the measuring pass inside `measure` until `release()`. */
  async function blockedMeasuringPrune() {
    const { measure } = await import("./repositories");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(measure).mockImplementationOnce(async (id: string) => {
      entered();
      await gate;
      disk.measured.push(id);
      return { repositoryBytes: 0n, checkouts: [], totalBytes: 0n };
    });
    const running = pruneStorage({ measure: true }, deps);
    await inside;
    return { running, release };
  }

  it("answers a checkout-created prune at once while a pass runs, and the holder runs one more pass", async () => {
    addRepo("r1", 0n, 1);
    const { totalStorageBytes } = await import("./repositories");
    vi.mocked(totalStorageBytes).mockClear();
    const { running, release } = await blockedMeasuringPrune();
    const coalesced = await pruneStorage({}, deps);
    expect(coalesced).toMatchObject({ coalesced: true, evictedCheckouts: [], measured: 0 });
    // A second request while the first is pending still costs one extra pass.
    await expect(pruneStorage({}, deps)).resolves.toMatchObject({ coalesced: true });
    release();
    const result = await running;
    expect(result.coalesced).toBeUndefined();
    expect(result.measured).toBe(1);
    // 2 coalesced answers + the measuring pass + exactly one extra pass.
    expect(vi.mocked(totalStorageBytes).mock.calls.length).toBe(4);
    // Released: the next request runs its own pass.
    vi.mocked(totalStorageBytes).mockClear();
    await expect(pruneStorage({}, deps)).resolves.not.toHaveProperty("coalesced");
    expect(vi.mocked(totalStorageBytes).mock.calls.length).toBe(1);
  });

  it("evicts in the extra pass what arrived during the measuring pass", async () => {
    addRepo("r1", 0n, 1);
    const { running, release } = await blockedMeasuringPrune();
    // The measuring pass reads the total after measuring; make it see an
    // under-cap disk, then a new checkout pushes usage over before the rerun.
    const { totalStorageBytes } = await import("./repositories");
    vi.mocked(totalStorageBytes).mockResolvedValueOnce(0n); // the coalesced answer
    await pruneStorage({}, deps);
    vi.mocked(totalStorageBytes).mockResolvedValueOnce(0n); // the measuring pass
    addCheckout("late", "r1", 2_000n, 1);
    release();
    const result = await running;
    expect(result.evictedCheckouts).toEqual(["late"]);
  });

  it("keeps measuring prunes and explicit caps waiting for the lock", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("c1", "r1", 50n, 1);
    const { running, release } = await blockedMeasuringPrune();
    let measuredDone = false;
    const measuring = pruneStorage({ measure: true }, deps).then((result) => {
      measuredDone = true;
      return result;
    });
    const capped = pruneStorage({ capBytes: 10n }, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(measuredDone).toBe(false);
    release();
    await running;
    expect((await measuring).coalesced).toBeUndefined();
    const cappedResult = await capped;
    expect(cappedResult.coalesced).toBeUndefined();
    expect(cappedResult.evictedCheckouts).toEqual(["c1"]);
  });

  it("does not coalesce when no pass is running", async () => {
    addRepo("r1", 0n, 1);
    addCheckout("c1", "r1", 2_000n, 1);
    const result = await pruneStorage({}, deps);
    expect(result.coalesced).toBeUndefined();
    expect(result.evictedCheckouts).toEqual(["c1"]);
  });
});

it("preserves snapshot clones, prunes their checkouts and warns if they prevent meeting the cap", async () => {
  disk.repositories.set("snapshot", {
    id: "snapshot",
    status: "READY",
    bytes: 1500n,
    lastUsedAt: null,
    packages: 1,
    isSnapshot: true,
  });
  disk.checkouts.set("checkout", {
    id: "checkout",
    repositoryId: "snapshot",
    status: "READY",
    bytes: 500n,
    lastUsedAt: null,
  });
  vi.mocked(prisma.repository.count).mockResolvedValue(1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await pruneStorage();
    expect(result.evictedCheckouts).toEqual(["checkout"]);
    expect(result.evictedRepositories).toEqual([]);
    expect(result.afterBytes).toBe(1500n);
    expect(disk.repositories.has("snapshot")).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("snapshot clones are protected"));
  } finally {
    warn.mockRestore();
  }
});
