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
const db = vi.mocked(prisma, { deep: true });
const { withCredentialSetupLock } = await import("./password-reset-links");
function pausePoint() {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      reach();
      await released;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  let tail = Promise.resolve();
  // Each transaction gets its own connection and release, modelling the real
  // setup advisory lock rather than merely asserting that SQL was called.
  db.$transaction.mockImplementation(
    async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      let unlock = () => {};
      const tx = new Proxy(prisma, {
        get(target, key) {
          if (key === "$executeRaw")
            return async (_sql: TemplateStringsArray, lockKey: string) => {
              expect(lockKey).toBe("set-password-link:u");
              const previous = tail;
              const held = pausePoint();
              tail = previous.then(() => held.wait());
              await previous;
              unlock = held.release;
              return 1;
            };
          return Reflect.get(target, key);
        },
      });
      try {
        return await run(tx);
      } finally {
        unlock();
      }
    },
  );
});
it("reset cleanup waits for an in-flight set-password mint and deletes its link", async () => {
  const pause = pausePoint();
  const links = new Set<string>();
  const mint = withCredentialSetupLock("u", async () => {
    await pause.wait();
    links.add("old-link");
  });
  await pause.reached;
  let cleanupStarted = false;
  const cleanup = withCredentialSetupLock("u", async () => {
    cleanupStarted = true;
    links.clear();
  });
  // Both have reached their transactions; a macrotask proves cleanup cannot
  // enter while mint still holds the same setup lock.
  await new Promise((resolve) => setImmediate(resolve));
  expect(cleanupStarted).toBe(false);
  pause.release();
  await Promise.all([mint, cleanup]);
  expect(cleanupStarted).toBe(true);
  expect([...links]).toEqual([]);
});
