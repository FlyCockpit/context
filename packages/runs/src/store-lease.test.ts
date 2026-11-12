import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/repos", async () => vi.importActual("../../repos/src/locks"));
vi.mock("../../repos/src/config", () => ({
  dataDir: () => "/unused",
  fetchIntervalMs: () => 300_000,
}));
vi.mock("../../repos/src/network", () => ({ withGitNetwork: vi.fn() }));
vi.mock("../../repos/src/paths", () => ({
  checkoutDir: () => "/unused/checkout",
  repositoryDir: () => "/unused/repo",
  repositoryCheckoutsDir: () => "/unused/checkouts",
  removeInsideDataDir: vi.fn(),
}));
vi.mock("../../repos/src/git-exec", () => ({ runGit: vi.fn() }));

const { default: prisma } = await import("@cockpit-context/db");
type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  checkout: { findUnique: Fn; aggregate: Fn; findMany: Fn; delete: Fn };
  repository: { findUnique: Fn; delete: Fn };
  checkoutLease: { count: Fn; upsert: Fn; updateMany: Fn };
};
const { prismaRunStore } = await import("./store");
const { deleteCheckout } = await vi.importActual<
  Pick<typeof import("@cockpit-context/repos"), "deleteCheckout">
>("../../repos/src/checkouts");
const { deleteRepository } = await vi.importActual<
  Pick<typeof import("@cockpit-context/repos"), "deleteRepository">
>("../../repos/src/repositories");
const { onCheckoutRemoval } = await vi.importActual<
  Pick<typeof import("@cockpit-context/repos"), "onCheckoutRemoval">
>("../../repos/src/removal-hooks");

beforeEach(() => {
  vi.resetAllMocks();
  // No live lease to renew: admission takes the gated path.
  db.checkoutLease.updateMany.mockResolvedValue({ count: 0 });
});

it("renews a still-live lease without queueing behind the repository lock", async () => {
  const { withRepositoryLock } =
    await vi.importActual<Pick<typeof import("@cockpit-context/repos"), "withRepositoryLock">>(
      "../../repos/src/locks",
    );
  db.checkoutLease.updateMany.mockResolvedValueOnce({ count: 1 });
  db.checkout.findUnique.mockResolvedValue({ id: "checkout-1", repositoryId: "repository-1" });
  let release!: () => void;
  const held = withRepositoryLock(
    "repository-1",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    // A slow fetch holds the lock; the renewal must not wait for it.
    await expect(
      prismaRunStore.acquireLease("run-1", "checkout-1", new Date(Date.now() + 60_000)),
    ).resolves.toBe(true);
    expect(db.checkoutLease.upsert).not.toHaveBeenCalled();
  } finally {
    release();
    await held;
  }
});

it.each(["checkout", "repository"])(
  "refuses lease admission after %s deletion has begun",
  async (kind) => {
    let exists = true;
    let leases = 0;
    db.checkout.findUnique.mockImplementation(async () =>
      exists
        ? {
            id: "checkout-1",
            repositoryId: "repository-1",
            sha: "a".repeat(40),
            diskBytes: 0n,
          }
        : null,
    );
    db.repository.findUnique.mockResolvedValue({ id: "repository-1", diskBytes: 0n });
    db.checkout.aggregate.mockResolvedValue({ _sum: { diskBytes: 0n } });
    db.checkout.findMany.mockResolvedValue([{ id: "checkout-1" }]);
    db.checkoutLease.count.mockImplementation(async () => leases);
    db.checkoutLease.upsert.mockImplementation(async () => {
      if (!exists) throw Object.assign(new Error("checkout removed"), { code: "P2003" });
      leases += 1;
      return { id: "lease-1" };
    });
    const remove = async () => {
      exists = false;
      leases = 0;
      return { id: "deleted" };
    };
    db.checkout.delete.mockImplementation(remove);
    db.repository.delete.mockImplementation(remove);
    let entered!: () => void;
    const atRemoval = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const off = onCheckoutRemoval(async () => {
      entered();
      await blocked;
    });
    try {
      const deletion =
        kind === "checkout" ? deleteCheckout("checkout-1") : deleteRepository("repository-1");
      await atRemoval;
      const admission = prismaRunStore.acquireLease(
        "run-1",
        "checkout-1",
        new Date(Date.now() + 60_000),
      );
      // Admission queues behind deletion; it cannot succeed in the removal hook.
      await Promise.resolve();
      release();
      await deletion;
      await expect(admission).resolves.toBe(false);
      expect(leases).toBe(0);
    } finally {
      release();
      off();
    }
  },
);
