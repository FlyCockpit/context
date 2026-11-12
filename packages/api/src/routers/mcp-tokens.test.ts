import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anonymousContext, sessionContext } from "../test-support/context";

const SECRET = "test-better-auth-secret-0123456789abcdef";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === "function" ? fn(db) : undefined,
  );
  return { default: db };
});
vi.mock("@cockpit-context/env/server", async () => {
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  return {
    env: {
      BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
      ...cockpitContextRateBudgetEnvDefaults(),
    },
    ADMIN_EMAILS: new Set<string>(),
  };
});

const { default: prisma } = await import("@cockpit-context/db");
const { mcpAgentTokenDigest, mcpAgentTokenLookupPrefix } = await import(
  "@cockpit-context/db/mcp-agent-token"
);
const { mcpTokensRouter } = await import("./mcp-tokens");

const db = prisma as unknown as {
  $transaction: MockInstance;
  mcpAgentToken: {
    findMany: MockInstance;
    findFirst: MockInstance;
    count: MockInstance;
    create: MockInstance;
    updateMany: MockInstance;
  };
};

const NOW = new Date("2026-10-01T00:00:00Z");

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    createdAt: NOW,
    name: "laptop",
    lookupPrefix: "cockpit_context_abcdefghijkl",
    allowPropose: true,
    autoApprove: false,
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(mcpTokensRouter, { context });
}

function expectReason(code: string, reason?: string) {
  return (error: ORPCError<string, { reason?: string }>) => {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe(code);
    if (reason) expect(error.data.reason).toBe(reason);
    return true;
  };
}

describe("mcpTokensRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).create({ name: "x" })).rejects.toSatisfy(
      expectReason("UNAUTHORIZED"),
    );
  });

  describe("list", () => {
    it("scopes to the caller and never selects the digest", async () => {
      db.mcpAgentToken.findMany.mockResolvedValue([
        tokenRow(),
        tokenRow({ id: "tok-2", revokedAt: NOW }),
        tokenRow({ id: "tok-3", expiresAt: new Date("2020-01-01") }),
      ]);
      const result = await client().list({});
      const args = db.mcpAgentToken.findMany.mock.calls[0]?.[0];
      expect(args.where).toEqual({ AND: [{ userId: "user-a" }] });
      expect(args.select).not.toHaveProperty("secretDigest");
      expect(result.items.map((item) => item.state)).toEqual(["active", "revoked", "expired"]);
      expect(result.items[0]).not.toHaveProperty("secretDigest");
    });
  });

  describe("create", () => {
    it("returns the plaintext once and stores only its prefix and HMAC digest", async () => {
      db.mcpAgentToken.count.mockResolvedValue(0);
      db.mcpAgentToken.create.mockImplementation(async ({ data }: { data: object }) =>
        tokenRow(data),
      );
      const result = await client().create({ name: "laptop", autoApprove: true });
      expect(result.secret).toMatch(/^cockpit_context_[A-Za-z0-9_-]{43}$/);
      const data = db.mcpAgentToken.create.mock.calls[0]?.[0].data;
      expect(data).toMatchObject({
        userId: "user-a",
        name: "laptop",
        allowPropose: true,
        autoApprove: true,
        expiresAt: null,
      });
      expect(data.lookupPrefix).toBe(mcpAgentTokenLookupPrefix(result.secret));
      expect(data.secretDigest).toBe(mcpAgentTokenDigest(result.secret, SECRET));
      expect(JSON.stringify(data)).not.toContain(result.secret);
      expect(db.mcpAgentToken.create.mock.calls[0]?.[0].select).not.toHaveProperty("secretDigest");
      expect(result.token).not.toHaveProperty("secretDigest");
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
    });

    it("retries a serialization failure, then reports CONFLICT instead of a 500", async () => {
      const serialization = Object.assign(new Error("could not serialize access"), {
        code: "P2034",
      });
      db.mcpAgentToken.count.mockResolvedValue(0);
      db.mcpAgentToken.create
        .mockRejectedValueOnce(serialization)
        .mockImplementationOnce(async ({ data }: { data: object }) => tokenRow(data));
      const result = await client().create({ name: "laptop" });
      expect(result.secret).toMatch(/^cockpit_context_/);
      expect(db.$transaction).toHaveBeenCalledTimes(2);

      db.$transaction.mockClear();
      db.mcpAgentToken.create.mockRejectedValue(serialization);
      await expect(client().create({ name: "laptop" })).rejects.toSatisfy(
        expectReason("CONFLICT", "CREATE_CONFLICT"),
      );
      expect(db.$transaction).toHaveBeenCalledTimes(3);

      db.mcpAgentToken.create.mockRejectedValue(new Error("boom"));
      await expect(client().create({ name: "laptop" })).rejects.toThrow();
      db.mcpAgentToken.create.mockReset();
    });

    it("never auto-approves for a token that may not propose", async () => {
      db.mcpAgentToken.count.mockResolvedValue(0);
      db.mcpAgentToken.create.mockImplementation(async ({ data }: { data: object }) =>
        tokenRow(data),
      );
      await client().create({ name: "ro", allowPropose: false, autoApprove: true });
      expect(db.mcpAgentToken.create.mock.calls[0]?.[0].data).toMatchObject({
        allowPropose: false,
        autoApprove: false,
      });
    });

    it("refuses past and far-future expiries and the active-token cap", async () => {
      await expect(
        client().create({ name: "x", expiresAt: new Date(Date.now() - 1_000) }),
      ).rejects.toSatisfy(expectReason("BAD_REQUEST", "EXPIRY_IN_PAST"));
      await expect(
        client().create({ name: "x", expiresAt: new Date(Date.now() + 400 * 86_400_000) }),
      ).rejects.toSatisfy(expectReason("BAD_REQUEST", "EXPIRY_TOO_FAR"));
      db.mcpAgentToken.count.mockResolvedValue(50);
      await expect(client().create({ name: "x" })).rejects.toSatisfy(
        expectReason("CONFLICT", "TOKEN_LIMIT"),
      );
      expect(db.mcpAgentToken.create).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("changes flags on the caller's live token", async () => {
      db.mcpAgentToken.findFirst
        .mockResolvedValueOnce(tokenRow())
        .mockResolvedValueOnce(tokenRow({ autoApprove: true }));
      db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
      const result = await client().update({ id: "tok-1", autoApprove: true });
      expect(db.mcpAgentToken.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [{ id: "tok-1" }, { userId: "user-a" }],
      });
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
        where: {
          id: "tok-1",
          userId: "user-a",
          revokedAt: null,
          allowPropose: true,
          autoApprove: false,
        },
        data: { allowPropose: true, autoApprove: true },
      });
      expect(result.autoApprove).toBe(true);
    });

    it("renames without rewriting flags read before a concurrent permission edit", async () => {
      db.mcpAgentToken.findFirst.mockResolvedValue(
        tokenRow({ allowPropose: true, autoApprove: true }),
      );
      db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
      await client().update({ id: "tok-1", name: "new name" });
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
        where: { id: "tok-1", userId: "user-a", revokedAt: null },
        data: { name: "new name" },
      });
    });

    it("refuses a flag update whose read was superseded by another writer", async () => {
      db.mcpAgentToken.findFirst.mockResolvedValue(
        tokenRow({ allowPropose: true, autoApprove: true }),
      );
      db.mcpAgentToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(client().update({ id: "tok-1", autoApprove: false })).rejects.toSatisfy(
        expectReason("CONFLICT", "TOKEN_CHANGED"),
      );
      expect(db.mcpAgentToken.updateMany.mock.calls[0]?.[0].where).toMatchObject({
        allowPropose: true,
        autoApprove: true,
      });
    });

    it("is NOT_FOUND for another user's token and CONFLICT for a revoked one", async () => {
      db.mcpAgentToken.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).update({ id: "tok-1", allowPropose: false }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      db.mcpAgentToken.findFirst.mockResolvedValue(tokenRow({ revokedAt: NOW }));
      await expect(client().update({ id: "tok-1", allowPropose: false })).rejects.toSatisfy(
        expectReason("CONFLICT", "TOKEN_REVOKED"),
      );
      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("revokes the caller's token", async () => {
      db.mcpAgentToken.findFirst.mockResolvedValue({ id: "tok-1" });
      db.mcpAgentToken.updateMany.mockResolvedValue({ count: 1 });
      await expect(client().revoke({ id: "tok-1" })).resolves.toEqual({ ok: true });
      expect(db.mcpAgentToken.updateMany).toHaveBeenCalledWith({
        where: { id: "tok-1", userId: "user-a", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("is NOT_FOUND for another user's token", async () => {
      db.mcpAgentToken.findFirst.mockResolvedValue(null);
      await expect(
        client(sessionContext({ id: "user-b" })).revoke({ id: "tok-1" }),
      ).rejects.toSatisfy(expectReason("NOT_FOUND"));
      expect(db.mcpAgentToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
