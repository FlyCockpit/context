import { mintMcpAgentToken } from "@cockpit-context/db/mcp-agent-token";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpCredentialPrisma } from "./credentials";

// mcp-grant.ts (the claim name) imports the Prisma client.
vi.mock("@cockpit-context/db", () => ({ default: {} }));

const {
  isMcpIdentityLive,
  credentialKey,
  extractBearerToken,
  resolveAgentToken,
  resolveOauthClaims,
} = await import("./credentials");

const SECRET = "test-better-auth-secret-0123456789abcdef";
const NOW = new Date("2026-10-24T12:00:00Z");

function fakePrisma() {
  return {
    mcpAgentToken: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    mcpGrant: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
}

const LIVE_USER = { id: "user-a", banned: false, banExpires: null as Date | null };

type FakePrisma = ReturnType<typeof fakePrisma>;

/** The fake implements only the delegate methods the resolver calls. */
function asPrisma(prisma: FakePrisma): McpCredentialPrisma {
  return prisma as unknown as McpCredentialPrisma;
}

function tokenRow(minted: ReturnType<typeof mintMcpAgentToken>, overrides = {}) {
  return {
    id: "tok-1",
    userId: "user-a",
    name: "Claude Code",
    secretDigest: minted.secretDigest,
    allowPropose: true,
    autoApprove: true,
    revokedAt: null,
    expiresAt: null,
    User: LIVE_USER,
    ...overrides,
  };
}

function resolveToken(token: string, prisma: FakePrisma) {
  return resolveAgentToken(token, { prisma: asPrisma(prisma), secret: SECRET, now: NOW });
}

describe("extractBearerToken", () => {
  it("reads only the Bearer scheme", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("DPoP abc")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer a b")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });
});

describe("resolveAgentToken", () => {
  let prisma: FakePrisma;
  beforeEach(() => {
    prisma = fakePrisma();
  });

  it("resolves a live token to its row's user and flags, by lookup prefix and digest", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted));
    const result = await resolveToken(minted.token, prisma);
    expect(prisma.mcpAgentToken.findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { lookupPrefix: minted.lookupPrefix },
      // The ban state comes from the same query, never a second lookup.
      select: { User: { select: { id: true, banned: true, banExpires: true } } },
    });
    expect(prisma.mcpAgentToken.findUnique).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      identity: {
        userId: "user-a",
        credential: { kind: "agent_token", tokenId: "tok-1" },
        label: "Claude Code",
        allowPropose: true,
        autoApprove: true,
      },
    });
  });

  it("refuses a token whose digest does not match (same prefix, different secret)", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted));
    const forged = `${minted.lookupPrefix}${"A".repeat(minted.token.length - minted.lookupPrefix.length)}`;
    const result = await resolveToken(forged, prisma);
    expect(result).toMatchObject({ ok: false, refusal: "unauthorized" });
  });

  it("refuses a digest made under another BETTER_AUTH_SECRET", async () => {
    const minted = mintMcpAgentToken("another-secret-0123456789abcdef0123");
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted));
    expect(await resolveToken(minted.token, prisma)).toMatchObject({ ok: false });
  });

  it("refuses revoked and expired tokens", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted, { revokedAt: NOW }));
    expect(await resolveToken(minted.token, prisma)).toMatchObject({
      ok: false,
      refusal: "unauthorized",
    });
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { expiresAt: new Date(NOW.getTime() - 1) }),
    );
    expect(await resolveToken(minted.token, prisma)).toMatchObject({
      ok: false,
      refusal: "unauthorized",
    });
  });

  it("refuses an unknown token and a non-Cockpit Context bearer without a lookup", async () => {
    prisma.mcpAgentToken.findUnique.mockResolvedValue(null);
    expect(await resolveToken(mintMcpAgentToken(SECRET).token, prisma)).toMatchObject({
      ok: false,
    });
    expect(await resolveToken("eyJhbGciOi.x.y", prisma)).toMatchObject({ ok: false });
    expect(prisma.mcpAgentToken.findUnique).toHaveBeenCalledOnce();
  });

  it("refuses a banned user with 403", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { User: { ...LIVE_USER, banned: true } }),
    );
    expect(await resolveToken(minted.token, prisma)).toMatchObject({
      ok: false,
      refusal: "forbidden",
    });
    expect(prisma.mcpAgentToken.updateMany).not.toHaveBeenCalled();
  });

  it("admits a user whose temporary ban has lapsed", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, {
        User: { ...LIVE_USER, banned: true, banExpires: new Date(Date.now() - 60_000) },
      }),
    );
    expect((await resolveToken(minted.token, prisma)).ok).toBe(true);
  });

  it("answers a wrong digest as unknown even when the user is banned", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { User: { ...LIVE_USER, banned: true } }),
    );
    const forged = `${minted.lookupPrefix}${"A".repeat(minted.token.length - minted.lookupPrefix.length)}`;
    expect(await resolveToken(forged, prisma)).toEqual({
      ok: false,
      refusal: "unauthorized",
      reason: "unknown API token",
    });
  });

  it("answers a revoked token as revoked before checking the ban", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { revokedAt: NOW, User: { ...LIVE_USER, banned: true } }),
    );
    expect(await resolveToken(minted.token, prisma)).toMatchObject({
      ok: false,
      refusal: "unauthorized",
      reason: "revoked API token",
    });
  });

  it("forces auto-approve off when the token may not propose", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { allowPropose: false, autoApprove: true }),
    );
    const result = await resolveToken(minted.token, prisma);
    expect(result.ok && result.identity.autoApprove).toBe(false);
  });

  it("stamps lastUsedAt at most once a minute", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted));
    await resolveToken(minted.token, prisma);
    expect(prisma.mcpAgentToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: "tok-1",
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(NOW.getTime() - 60_000) } }],
      },
      data: { lastUsedAt: NOW },
    });
  });

  it("skips the write when the row's stamp is fresh", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { lastUsedAt: new Date(NOW.getTime() - 30_000) }),
    );
    expect((await resolveToken(minted.token, prisma)).ok).toBe(true);
    expect(prisma.mcpAgentToken.findUnique.mock.calls[0]?.[0]).toMatchObject({
      select: { lastUsedAt: true },
    });
    expect(prisma.mcpAgentToken.updateMany).not.toHaveBeenCalled();
  });

  it("stamps a stale row with the guarded write", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(minted, { lastUsedAt: new Date(NOW.getTime() - 120_000) }),
    );
    await resolveToken(minted.token, prisma);
    expect(prisma.mcpAgentToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: "tok-1",
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(NOW.getTime() - 60_000) } }],
      },
      data: { lastUsedAt: NOW },
    });
  });

  it("never fails admission when stamping fails", async () => {
    const minted = mintMcpAgentToken(SECRET);
    prisma.mcpAgentToken.findUnique.mockResolvedValue(tokenRow(minted));
    prisma.mcpAgentToken.updateMany.mockRejectedValue(new Error("db down"));
    expect((await resolveToken(minted.token, prisma)).ok).toBe(true);
  });
});

describe("resolveOauthClaims", () => {
  let prisma: FakePrisma;
  const grant = {
    id: "grant-1",
    userId: "user-a",
    clientId: "client-1",
    clientName: "Claude Code",
    allowPropose: false,
    autoApprove: false,
    revokedAt: null,
    User: LIVE_USER,
  };
  beforeEach(() => {
    prisma = fakePrisma();
    prisma.mcpGrant.findUnique.mockResolvedValue(grant);
  });

  function resolve(claims: Record<string, unknown>) {
    return resolveOauthClaims(claims, { prisma: asPrisma(prisma), now: NOW });
  }

  it("resolves verified claims to the grant's user and flags", async () => {
    const result = await resolve({ sub: "user-a", client_id: "client-1", mcp_grant_id: "grant-1" });
    expect(result).toEqual({
      ok: true,
      identity: {
        userId: "user-a",
        credential: { kind: "oauth", grantId: "grant-1", clientId: "client-1" },
        label: "Claude Code",
        allowPropose: false,
        autoApprove: false,
      },
    });
  });

  it("requires the private grant claim", async () => {
    expect(await resolve({ sub: "user-a", client_id: "client-1" })).toMatchObject({
      ok: false,
      refusal: "unauthorized",
    });
  });

  const claims = { sub: "user-a", client_id: "client-1", mcp_grant_id: "grant-1" };

  it("stamps a grant never used before", async () => {
    await resolve(claims);
    expect(prisma.mcpGrant.updateMany).toHaveBeenCalledOnce();
  });

  it("skips the write when the grant's stamp is fresh", async () => {
    prisma.mcpGrant.findUnique.mockResolvedValue({
      ...grant,
      lastUsedAt: new Date(NOW.getTime() - 30_000),
    });
    expect((await resolve(claims)).ok).toBe(true);
    expect(prisma.mcpGrant.findUnique.mock.calls[0]?.[0]).toMatchObject({
      select: { lastUsedAt: true },
    });
    expect(prisma.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("stamps a stale grant with the guarded write", async () => {
    prisma.mcpGrant.findUnique.mockResolvedValue({
      ...grant,
      lastUsedAt: new Date(NOW.getTime() - 120_000),
    });
    await resolve(claims);
    expect(prisma.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(NOW.getTime() - 60_000) } }],
      },
      data: { lastUsedAt: NOW },
    });
  });

  it("reads the grant's user in the same query and refuses a banned one with 403", async () => {
    prisma.mcpGrant.findUnique.mockResolvedValue({
      ...grant,
      User: { ...LIVE_USER, banned: true },
    });
    expect(await resolve(claims)).toMatchObject({
      ok: false,
      refusal: "forbidden",
      reason: "user banned",
    });
    expect(prisma.mcpGrant.findUnique).toHaveBeenCalledOnce();
    expect(prisma.mcpGrant.findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "grant-1" },
      select: { User: { select: { id: true, banned: true, banExpires: true } } },
    });
    expect(prisma.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("answers a mismatched grant as forbidden-mismatch even when its user is banned", async () => {
    prisma.mcpGrant.findUnique.mockResolvedValue({
      ...grant,
      User: { ...LIVE_USER, banned: true },
    });
    expect(await resolve({ ...claims, sub: "user-b" })).toMatchObject({
      ok: false,
      refusal: "forbidden",
      reason: "grant missing, mismatched or revoked",
    });
  });

  it("refuses a revoked grant and a grant of another user or client", async () => {
    prisma.mcpGrant.findUnique.mockResolvedValueOnce({ ...grant, revokedAt: NOW });
    expect(
      await resolve({ sub: "user-a", client_id: "client-1", mcp_grant_id: "grant-1" }),
    ).toMatchObject({ ok: false, refusal: "forbidden" });
    expect(
      await resolve({ sub: "user-b", client_id: "client-1", mcp_grant_id: "grant-1" }),
    ).toMatchObject({ ok: false, refusal: "forbidden" });
    expect(
      await resolve({ sub: "user-a", client_id: "client-2", mcp_grant_id: "grant-1" }),
    ).toMatchObject({ ok: false, refusal: "forbidden" });
  });
});

describe("credentialKey", () => {
  it("separates tokens and grants", () => {
    expect(credentialKey({ kind: "agent_token", tokenId: "x" })).toBe("token:x");
    expect(credentialKey({ kind: "oauth", grantId: "x", clientId: "c" })).toBe("grant:x");
  });
});

describe("isMcpIdentityLive", () => {
  const identity = {
    userId: "user-a",
    credential: { kind: "agent_token" as const, tokenId: "tok-1" },
    label: "test",
    allowPropose: true,
    autoApprove: false,
  };
  it.each([
    [{}, true],
    [{ revokedAt: NOW }, false],
    [{ expiresAt: new Date(0) }, false],
    [{ User: { ...LIVE_USER, banned: true } }, false],
    [{ userId: "other" }, false],
  ])("checks held token row %j", async (overrides, expected) => {
    const prisma = fakePrisma();
    prisma.mcpAgentToken.findUnique.mockResolvedValue(
      tokenRow(mintMcpAgentToken(SECRET), overrides),
    );
    await expect(isMcpIdentityLive(identity, asPrisma(prisma))).resolves.toBe(expected);
  });
  it("checks OAuth revocation and owner bans", async () => {
    const prisma = fakePrisma();
    const oauth = {
      ...identity,
      credential: { kind: "oauth" as const, grantId: "g", clientId: "c" },
    };
    const row = { userId: "user-a", clientId: "c", revokedAt: null, User: LIVE_USER };
    prisma.mcpGrant.findUnique.mockResolvedValue(row);
    await expect(isMcpIdentityLive(oauth, asPrisma(prisma))).resolves.toBe(true);
    prisma.mcpGrant.findUnique.mockResolvedValue({ ...row, revokedAt: NOW });
    await expect(isMcpIdentityLive(oauth, asPrisma(prisma))).resolves.toBe(false);
    prisma.mcpGrant.findUnique.mockResolvedValue({ ...row, User: { ...LIVE_USER, banned: true } });
    await expect(isMcpIdentityLive(oauth, asPrisma(prisma))).resolves.toBe(false);
  });
});
