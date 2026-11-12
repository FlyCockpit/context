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
vi.mock("@cockpit-context/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));

const { default: prisma } = await import("@cockpit-context/db");
const { mcpConnectionsRouter } = await import("./mcp-connections");

const db = prisma as unknown as {
  mcpGrant: { findMany: MockInstance; findFirst: MockInstance; updateMany: MockInstance };
  oauthAccessToken: { deleteMany: MockInstance };
  oauthRefreshToken: { deleteMany: MockInstance };
  oauthConsent: { deleteMany: MockInstance };
  $transaction: MockInstance;
};

const NOW = new Date("2026-10-01T00:00:00Z");

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    createdAt: NOW,
    clientId: "client-abc",
    clientName: "Claude Code",
    allowPropose: true,
    autoApprove: false,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(mcpConnectionsRouter, { context });
}

describe("mcpConnectionsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).list({})).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "UNAUTHORIZED",
    );
  });

  it("lists the caller's grants without the consent reference", async () => {
    db.mcpGrant.findMany.mockResolvedValue([grantRow({ referenceId: "consent-1" })]);
    const result = await client().list({});
    const args = db.mcpGrant.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ AND: [{ userId: "user-a" }] });
    expect(args.select).not.toHaveProperty("referenceId");
    expect(result.items[0]).not.toHaveProperty("referenceId");
    expect(result.items[0]?.state).toBe("active");
  });

  it("updates flags; auto-approve needs propose", async () => {
    db.mcpGrant.findFirst.mockResolvedValue(grantRow({ autoApprove: true }));
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const result = await client().update({ id: "grant-1", allowPropose: false });
    expect(db.mcpGrant.findFirst.mock.calls[0]?.[0].where).toEqual({
      AND: [{ id: "grant-1" }, { userId: "user-a" }],
    });
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        userId: "user-a",
        revokedAt: null,
        allowPropose: true,
        autoApprove: true,
      },
      data: { allowPropose: false, autoApprove: false },
    });
    expect(result).toMatchObject({ allowPropose: false, autoApprove: false });
  });

  it("refuses a flag update when another writer changed the compared state", async () => {
    db.mcpGrant.findFirst.mockResolvedValue(grantRow({ autoApprove: true }));
    db.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(client().update({ id: "grant-1", autoApprove: false })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "CONNECTION_CHANGED" },
    });
    expect(db.mcpGrant.updateMany.mock.calls[0]?.[0].where).toMatchObject({
      allowPropose: true,
      autoApprove: true,
    });
  });

  it("is NOT_FOUND for another user's grant", async () => {
    db.mcpGrant.findFirst.mockResolvedValue(null);
    const other = client(sessionContext({ id: "user-b" }));
    await expect(other.update({ id: "grant-1", autoApprove: true })).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
    );
    await expect(other.revoke({ id: "grant-1" })).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
    );
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to edit a revoked grant and revokes idempotently", async () => {
    db.mcpGrant.findFirst.mockResolvedValue(grantRow({ revokedAt: NOW }));
    await expect(client().update({ id: "grant-1", autoApprove: true })).rejects.toSatisfy(
      (error: ORPCError<string, { reason: string }>) =>
        error.code === "CONFLICT" && error.data.reason === "CONNECTION_REVOKED",
    );
    db.mcpGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      clientId: "client-abc",
      referenceId: "consent-1",
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(client().revoke({ id: "grant-1" })).resolves.toEqual({ ok: true });
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-a",
        clientId: "client-abc",
        referenceId: "consent-1",
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("revoking ends the generation's OAuth tokens and consent, in one transaction", async () => {
    db.mcpGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      clientId: "client-abc",
      referenceId: "consent-1",
    });
    await client().revoke({ id: "grant-1" });
    const generation = { userId: "user-a", clientId: "client-abc", referenceId: "consent-1" };
    expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledWith({ where: generation });
    expect(db.oauthRefreshToken.deleteMany).toHaveBeenCalledWith({ where: generation });
    expect(db.oauthConsent.deleteMany).toHaveBeenCalledWith({ where: generation });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
});
