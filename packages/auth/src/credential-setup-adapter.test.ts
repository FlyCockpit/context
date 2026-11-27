import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { beforeEach, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@cockpit-context/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-context/db", async () => {
  const { createMockContext } = await vi.importActual<{
    createMockContext: () => { db: typeof prisma };
  }>("../../test-utils/src/index");
  return { default: createMockContext().db };
});
const memory = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>[]>);
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { prismaAdapter: vi.fn(() => memoryAdapter(memory)) };
});
const { prismaAdapter } = await import("better-auth/adapters/prisma");
const { default: prisma } = await import("@cockpit-context/db");
const db = vi.mocked(prisma, { deep: true });
const { createCredentialSetupAdapter } = await import("./credential-setup-adapter");
const { withPasswordWriteLock, passwordWriteLockHeld } = await import("./password-write-lock");
const { handlePasswordAuthRequest } = await import("./password-auth-handler");
const now = new Date();
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(memory)) delete memory[key];
  memory.user = [
    {
      id: "u",
      email: "user@example.test",
      emailVerified: false,
      name: "User",
      createdAt: now,
      updatedAt: now,
    },
  ];
  memory.account = [
    { id: "a", accountId: "u", userId: "u", providerId: "credential", password: "old" },
  ];
  memory.session = [];
  memory.verification = [
    {
      id: "v",
      identifier: "reset-password:t",
      value: "u",
      expiresAt: new Date(Date.now() + 60_000),
    },
  ];
  db.$transaction.mockImplementation(async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[]),
  );
  db.$executeRaw.mockResolvedValue(1);
  db.$queryRaw.mockResolvedValue([{ locked: true }]);
  (db.verification.findFirst as MockInstance).mockImplementation(async ({ where }) => {
    return memory.verification?.find((row) => row.identifier === where?.identifier) ?? null;
  });
  (db.user.findUnique as MockInstance).mockImplementation(async () => ({
    ...memory.user![0],
    accounts: [{ providerId: "credential" }],
    sessions: [],
  }));
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
});
function instance(emailConfigured = true) {
  return betterAuth({
    database: createCredentialSetupAdapter({ emailConfigured }),
    secret: "disposable-adapter-unit-test-secret-123456789",
    baseURL: "https://app.example.test",
    rateLimit: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      password: { hash: async (value) => `hash:${value}`, verify: async () => true },
    },
  });
}
it.each(["update", "updateMany"] as const)(
  "%s refuses broad, insensitive and nonscalar verification selectors before lookup or writes",
  async (method) => {
    const context = await instance().$context;
    for (const where of [
      [],
      [{ field: "name", value: "User" }],
      [
        { field: "id", value: "u" },
        { field: "email", value: "user@example.test" },
      ],
      [{ field: "email", value: "user@example.test", mode: "insensitive" as const }],
      [{ field: "id", value: ["u"] }],
      [{ field: "id", value: "u", operator: "in" as const }],
    ]) {
      await expect(
        context.adapter[method]({ model: "user", where, update: { emailVerified: true } }),
      ).rejects.toThrow("exact user selector");
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(memory.user![0]!.emailVerified).toBe(false);
    }
  },
);
it.each([true, false])(
  "private-mode active shown reset admission preserves SMTP policy (%s)",
  async (emailConfigured) => {
    // A no-SMTP server intentionally hands active password-account links to admins.
    memory.user![0]!.emailVerified = true;
    const auth = instance(emailConfigured);
    const response = await handlePasswordAuthRequest(
      auth,
      new Request("https://app.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({ token: "t", newPassword: "new-password-123456" }),
      }),
    );
    expect(response.status).toBe(emailConfigured ? 400 : 200);
    expect(memory.account![0]!.password).toBe(emailConfigured ? "old" : "hash:new-password-123456");
    expect(db.user.updateMany).not.toHaveBeenCalled(); // shown links prove no mailbox
  },
);
it("transaction metadata remains request-aware after lock lapse and is not cached at factory startup", async () => {
  const context = await instance().$context;
  expect(context.adapter.options?.adapterConfig.transaction).toBe(false);
  const query = vi.spyOn(db, "$queryRaw");
  vi.useFakeTimers();
  try {
    await withPasswordWriteLock(
      "/reset-password",
      new Request("https://app.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "t" }),
      }),
      async () => {
        expect(context.adapter.options?.adapterConfig.transaction).toBeTypeOf("function");
        await vi.advanceTimersByTimeAsync(26_000);
        expect(passwordWriteLockHeld()).toBe(false);
        expect(context.adapter.options?.adapterConfig.transaction).toBeTypeOf("function");
        return new Response(randomUUID());
      },
      { getSession: async () => null },
    );
    expect(context.adapter.options?.adapterConfig.transaction).toBe(false);
  } finally {
    vi.useRealTimers();
    query.mockRestore();
  }
});
it.each(["update", "updateMany"] as const)(
  "%s serializes an exact verification write on one transaction in canonical lock order",
  async (method) => {
    const { createMockContext } = await vi.importActual<{
      createMockContext: () => { db: typeof prisma };
    }>("../../test-utils/src/index");
    const tx = vi.mocked(createMockContext().db, { deep: true });
    tx.$executeRaw.mockResolvedValue(1);
    tx.verification.deleteMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    );
    const context = await instance().$context;
    await context.adapter[method]({
      model: "user",
      where: [{ field: "id", value: "u" }],
      update: { emailVerified: true },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(vi.mocked(prismaAdapter).mock.calls.some(([client]) => client === tx)).toBe(true);
    expect(
      tx.$executeRaw.mock.calls.map(([sql, key]) => [(sql as TemplateStringsArray).join("?"), key]),
    ).toEqual([
      ["SELECT pg_advisory_xact_lock(hashtext(?))", "password-write:u"],
      ["SELECT pg_advisory_xact_lock(1936028274, hashtext(?))", "u"],
      ["SELECT pg_advisory_xact_lock(hashtext(?))", "set-password-link:u"],
    ]);
    expect(memory.user![0]!.emailVerified).toBe(true);
    expect(tx.verification.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { value: "u", identifier: { startsWith: "reset-password:" } },
    });
  },
);
