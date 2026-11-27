import type { Prisma } from "@cockpit-context/db";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/db", async () => {
  const { createMockContext } = await vi.importActual<{
    createMockContext: () => { db: typeof prisma };
  }>("../../test-utils/src/index");
  return { default: createMockContext().db };
});
const { default: prisma } = await import("@cockpit-context/db");
const { createMockContext } = await vi.importActual<{
  createMockContext: () => { db: typeof prisma };
}>("../../test-utils/src/index");
const tx = vi.mocked(createMockContext().db, { deep: true });
const db = vi.mocked(prisma, { deep: true });
const {
  archiveUndoIdentifier,
  lockUserCredentials,
  revokeUserCredentialsInTransaction,
  withUserCredentialTransaction,
} = await import("./oauth-revocation");
const { withTransactionSlot } = await import("./lock-slots");
beforeEach(() => {
  vi.clearAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
  tx.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
  tx.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
  tx.oauthAccessToken.deleteMany.mockResolvedValue({ count: 1 });
  tx.oauthRefreshToken.deleteMany.mockResolvedValue({ count: 1 });
  tx.oauthConsent.deleteMany.mockResolvedValue({ count: 1 });
  tx.verification.deleteMany.mockResolvedValue({ count: 1 });
  tx.session.deleteMany.mockResolvedValue({ count: 1 });
});
it("locks and revokes on the supplied client, retaining grant tombstones and OAuth dependency order", async () => {
  await lockUserCredentials(tx, "u");
  await revokeUserCredentialsInTransaction(tx, "u", { revokeSessions: true });
  const [sql, key] = tx.$executeRaw.mock.calls[0]!;
  expect((sql as TemplateStringsArray).join("?")).toBe(
    "SELECT pg_advisory_xact_lock(1936028274, hashtext(?))",
  );
  expect(key).toBe("u");
  for (const write of [tx.mcpAgentToken.updateMany, tx.mcpGrant.updateMany]) {
    expect(write).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "u", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  }
  expect(tx.mcpGrant.deleteMany).not.toHaveBeenCalled();
  const writes = [
    tx.mcpAgentToken.updateMany,
    tx.mcpGrant.updateMany,
    tx.oauthAccessToken.deleteMany,
    tx.oauthRefreshToken.deleteMany,
    tx.oauthConsent.deleteMany,
    tx.session.deleteMany,
  ];
  const order = writes.map((write) => write.mock.invocationCallOrder[0]!);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: "u" } });
  expect(tx.verification.deleteMany).toHaveBeenCalledWith({
    where: { identifier: archiveUndoIdentifier("u") },
  });
  expect((tx.$executeRaw.mock.calls[1]![0] as TemplateStringsArray).join("?")).toContain(
    "WITH challenges",
  );
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.$executeRaw).not.toHaveBeenCalled();
  expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
  expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  expect(db.session.deleteMany).not.toHaveBeenCalled();
});
it("consumes its prepaid ticket before the owning credential transaction starts", async () => {
  db.$transaction.mockImplementation(
    async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx),
  );
  await withUserCredentialTransaction("u", async (client) => {
    expect(client).toBe(tx);
    // This scope has no spare. A second transaction cannot borrow its ticket.
    await expect(withTransactionSlot(async () => "unaccounted connection")).rejects.toBeInstanceOf(
      RangeError,
    );
  });
  expect(db.$transaction).toHaveBeenCalledOnce();
});

it("rejects an oversized nested reservation before checkout instead of waiting on its own slot", async () => {
  const { withLockSlot } = await import("./lock-slots");
  await withLockSlot(
    async () => {
      await expect(
        withLockSlot(async () => "too large", { nested: 1, deadline: performance.now() + 30 }),
      ).rejects.toBeInstanceOf(RangeError);
    },
    { nested: 1 },
  );
  expect(db.$transaction).not.toHaveBeenCalled();
});
