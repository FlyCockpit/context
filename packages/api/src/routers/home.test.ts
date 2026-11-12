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
const envMock = vi.hoisted(() => ({
  BETTER_AUTH_URL: "https://cockpit-context.example.com",
  OPENROUTER_API_KEY: undefined as string | undefined,
  COCKPIT_CONTEXT_MODEL: undefined as string | undefined,
}));
vi.mock("@cockpit-context/env/server", () => ({
  env: envMock,
  ADMIN_EMAILS: new Set<string>(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const { homeRouter } = await import("./home");

const db = prisma as unknown as {
  package: { findFirst: MockInstance };
  mcpAgentToken: { findFirst: MockInstance };
  mcpGrant: { findFirst: MockInstance };
  conversation: { findFirst: MockInstance; count: MockInstance };
  packageProposal: { count: MockInstance };
};

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(homeRouter, { context });
}

function primeEmpty() {
  db.package.findFirst.mockResolvedValue(null);
  db.mcpAgentToken.findFirst.mockResolvedValue(null);
  db.mcpGrant.findFirst.mockResolvedValue(null);
  db.conversation.findFirst.mockResolvedValue(null);
  db.conversation.count.mockResolvedValue(0);
  db.packageProposal.count.mockResolvedValue(0);
}

describe("homeRouter.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeEmpty();
    envMock.OPENROUTER_API_KEY = undefined;
    envMock.COCKPIT_CONTEXT_MODEL = undefined;
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).status()).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "UNAUTHORIZED",
    );
    expect(db.package.findFirst).not.toHaveBeenCalled();
  });

  it("reports a fresh account as not started", async () => {
    await expect(client().status()).resolves.toEqual({
      modelConfigured: false,
      hasPackages: false,
      hasConnection: false,
      hasConversations: false,
      pendingProposals: 0,
      ongoingConversations: 0,
      mcpUrl: "https://cockpit-context.example.com/mcp",
    });
  });

  it.each([
    [undefined, undefined, false],
    ["test-key", undefined, false],
    [undefined, "test-model", false],
    ["test-key", "test-model", true],
  ])("reports model availability as a boolean (%s, %s)", async (key, model, expected) => {
    envMock.OPENROUTER_API_KEY = key;
    envMock.COCKPIT_CONTEXT_MODEL = model;
    const result = await client().status();
    expect(result.modelConfigured).toBe(expected);
    expect(result).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(result).not.toHaveProperty("COCKPIT_CONTEXT_MODEL");
  });

  it("scopes every read to the caller", async () => {
    await client().status();
    expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({ ownerId: "user-a" });
    expect(db.mcpAgentToken.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      userId: "user-a",
      revokedAt: null,
    });
    expect(db.mcpGrant.findFirst.mock.calls[0]?.[0].where).toEqual({
      userId: "user-a",
      revokedAt: null,
    });
    expect(db.conversation.findFirst.mock.calls[0]?.[0].where).toEqual({ ownerId: "user-a" });
    expect(db.packageProposal.count.mock.calls[0]?.[0].where).toEqual({
      ownerId: "user-a",
      status: "PENDING",
    });
    expect(db.conversation.count.mock.calls[0]?.[0].where.AND[0]).toEqual({ ownerId: "user-a" });
  });

  it("ignores expired tokens", async () => {
    await client().status();
    const where = db.mcpAgentToken.findFirst.mock.calls[0]?.[0].where;
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it("counts an active token or an active OAuth grant as a connection", async () => {
    db.mcpAgentToken.findFirst.mockResolvedValue({ id: "token-1" });
    expect((await client().status()).hasConnection).toBe(true);

    db.mcpAgentToken.findFirst.mockResolvedValue(null);
    db.mcpGrant.findFirst.mockResolvedValue({ id: "grant-1" });
    expect((await client().status()).hasConnection).toBe(true);
  });

  it("returns the badge and ongoing counts", async () => {
    db.package.findFirst.mockResolvedValue({ id: "pkg-1" });
    db.conversation.findFirst.mockResolvedValue({ id: "conv-1" });
    db.packageProposal.count.mockResolvedValue(3);
    db.conversation.count.mockResolvedValue(2);
    await expect(client().status()).resolves.toMatchObject({
      hasPackages: true,
      hasConversations: true,
      pendingProposals: 3,
      ongoingConversations: 2,
    });
  });
});
