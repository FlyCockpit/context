import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { createMockContext } = await vi.importActual<{
    createMockContext: () => { db: typeof prisma };
  }>("../../test-utils/src/index");
  const db = createMockContext().db;
  vi.mocked(db.$transaction).mockImplementation(async (run: unknown) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(db);
  });
  vi.mocked(db.session.findFirst).mockResolvedValue({
    id: "s1",
    userId: "u",
    token: "session-token",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: null,
    userAgent: null,
    impersonatedBy: null,
  });
  return { default: db };
});

const { default: prisma } = await import("@cockpit-context/db");
const { deriveMcpConsentReferenceId, issueMcpGrantClaims, McpGrantError, resolveMcpGrantDecision } =
  await import("./mcp-grant");

const db = prisma as unknown as {
  mcpGrant: { findUnique: MockInstance; createMany: MockInstance; updateMany: MockInstance };
  oauthClient: { findUnique: MockInstance };
  session: { findFirst: MockInstance };
};

const SECRET = "secret-for-tests-0123456789abcdef";
const active = { id: "g1", userId: "u", clientId: "c", referenceId: "r", revokedAt: null };
const tombstone = { ...active, revokedAt: new Date() };

describe("deriveMcpConsentReferenceId", () => {
  it("is deterministic per session and client", () => {
    const a = deriveMcpConsentReferenceId({ secret: SECRET, sessionId: "s1", clientId: "c" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveMcpConsentReferenceId({ secret: SECRET, sessionId: "s1", clientId: "c" })).toBe(a);
    expect(
      deriveMcpConsentReferenceId({ secret: SECRET, sessionId: "s2", clientId: "c" }),
    ).not.toBe(a);
  });
});

describe("resolveMcpGrantDecision", () => {
  it("creates, reuses, and refuses tombstones on code exchange", () => {
    const base = { grantType: "authorization_code" as const, userId: "u", referenceId: "r" };
    expect(resolveMcpGrantDecision({ ...base, existing: null })).toEqual({ action: "create" });
    expect(resolveMcpGrantDecision({ ...base, existing: active })).toEqual({
      action: "reuse",
      grant: active,
    });
    expect(resolveMcpGrantDecision({ ...base, existing: tombstone })).toEqual({
      action: "reject",
      reason: "tombstone",
    });
  });

  it("requires the exact active grant on refresh", () => {
    const base = { grantType: "refresh_token" as const, userId: "u", referenceId: "r" };
    expect(resolveMcpGrantDecision({ ...base, existing: null })).toMatchObject({
      action: "reject",
    });
    expect(resolveMcpGrantDecision({ ...base, existing: tombstone })).toMatchObject({
      action: "reject",
    });
  });
});

describe("issueMcpGrantClaims", () => {
  beforeEach(() => {
    db.mcpGrant.findUnique.mockReset();
    db.mcpGrant.createMany.mockReset();
    db.oauthClient.findUnique.mockReset();
  });

  it("stamps the grant id of a live generation", async () => {
    db.mcpGrant.findUnique.mockResolvedValue(active);
    await expect(
      issueMcpGrantClaims({
        grantType: "refresh_token",
        userId: "u",
        clientId: "c",
        referenceId: "r",
        secret: SECRET,
      }),
    ).resolves.toEqual({ mcp_grant_id: "g1" });
  });

  it("refuses to mint for a revoked generation", async () => {
    db.mcpGrant.findUnique.mockResolvedValue(tombstone);
    await expect(
      issueMcpGrantClaims({
        grantType: "authorization_code",
        sessionId: "s1",
        userId: "u",
        clientId: "c",
        referenceId: "r",
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(McpGrantError);
  });

  it("creates the grant on first code exchange with the client's name", async () => {
    db.mcpGrant.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(active);
    db.oauthClient.findUnique.mockResolvedValue({ name: "Claude Code" });
    await expect(
      issueMcpGrantClaims({
        grantType: "authorization_code",
        sessionId: "s1",
        userId: "u",
        clientId: "c",
        referenceId: "r",
        secret: SECRET,
      }),
    ).resolves.toEqual({ mcp_grant_id: "g1" });
    expect(db.mcpGrant.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
      userId: "u",
      clientId: "c",
      referenceId: "r",
      clientName: "Claude Code",
    });
  });

  it("fails closed without a durable reference on refresh", async () => {
    await expect(
      issueMcpGrantClaims({
        grantType: "refresh_token",
        userId: "u",
        clientId: "c",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ reason: "missing-session" });
  });
});
