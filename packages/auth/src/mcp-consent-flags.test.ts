import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", () => {
  const db = {
    mcpGrant: { createMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    oauthClient: { findUnique: vi.fn() },
    // Interactive transactions run against the same mock.
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(db)),
  };
  return { default: db };
});

const { default: prisma } = await import("@cockpit-context/db");
const { consentAccepts, consentFlagsOf, consentIssuedCode, recordConsentedMcpGrantFlags } =
  await import("./mcp-consent-flags");

const db = prisma as unknown as {
  mcpGrant: { createMany: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
};

describe("consentFlagsOf", () => {
  it("defaults to propose on, auto-approve off", () => {
    expect(consentFlagsOf({ accept: true })).toEqual({ allowPropose: true, autoApprove: false });
  });

  it("forces auto-approve off without propose", () => {
    expect(consentFlagsOf({ allowPropose: false, autoApprove: true })).toEqual({
      allowPropose: false,
      autoApprove: false,
    });
    expect(consentFlagsOf({ allowPropose: true, autoApprove: true })).toEqual({
      allowPropose: true,
      autoApprove: true,
    });
  });

  it("refuses a non-boolean flag", () => {
    expect(consentFlagsOf({ allowPropose: "yes" })).toBeNull();
    expect(consentFlagsOf({ autoApprove: 1 })).toBeNull();
  });
});

describe("consent outcome predicates", () => {
  it("accepts only a literal true", () => {
    expect(consentAccepts({ accept: true })).toBe(true);
    expect(consentAccepts({ accept: "true" })).toBe(false);
    expect(consentAccepts(null)).toBe(false);
  });

  it("recognizes an issued code, not an error redirect", () => {
    expect(
      consentIssuedCode({ redirect: true, url: "http://localhost:1/cb?code=abc&state=s" }),
    ).toBe(true);
    expect(
      consentIssuedCode({ redirect: true, url: "http://localhost:1/cb?error=access_denied" }),
    ).toBe(false);
    expect(consentIssuedCode({ redirect: false, url: "http://localhost:1/cb?code=a" })).toBe(false);
  });
});

describe("recordConsentedMcpGrantFlags", () => {
  const input = {
    userId: "user-a",
    clientId: "client-1",
    referenceId: "ref-1",
    clientName: "Claude Code",
    flags: { allowPropose: false, autoApprove: false },
  };

  beforeEach(() => {
    db.mcpGrant.createMany.mockReset();
    db.mcpGrant.findUnique.mockReset();
    db.mcpGrant.updateMany.mockReset();
  });

  it("creates the grant generation with the person's flags", async () => {
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.findUnique.mockResolvedValue({ id: "grant-1", revokedAt: null });
    await expect(recordConsentedMcpGrantFlags(input)).resolves.toEqual({ grantId: "grant-1" });
    expect(db.mcpGrant.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-a",
          clientId: "client-1",
          referenceId: "ref-1",
          clientName: "Claude Code",
          allowPropose: false,
          autoApprove: false,
        },
      ],
      skipDuplicates: true,
    });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("updates an active grant and leaves a tombstone alone", async () => {
    db.mcpGrant.createMany.mockResolvedValue({ count: 0 });
    db.mcpGrant.findUnique.mockResolvedValueOnce({ id: "grant-1", revokedAt: null });
    await recordConsentedMcpGrantFlags(input);
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: { id: "grant-1", revokedAt: null },
      data: { allowPropose: false, autoApprove: false, clientName: "Claude Code" },
    });
    db.mcpGrant.updateMany.mockReset();
    db.mcpGrant.createMany.mockResolvedValue({ count: 0 });
    db.mcpGrant.findUnique.mockResolvedValueOnce({ id: "grant-1", revokedAt: new Date() });
    await expect(recordConsentedMcpGrantFlags(input)).resolves.toBeNull();
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
});
