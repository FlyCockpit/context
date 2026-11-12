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
// The Cockpit Context rate budgets at their defaults: the procedure budgets read them on first consume.
vi.mock("@cockpit-context/env/server", async () => {
  const { cockpitContextRateBudgetEnvDefaults } = await import("@cockpit-context/env/rate-budgets");
  return { env: cockpitContextRateBudgetEnvDefaults(), ADMIN_EMAILS: new Set<string>() };
});
vi.mock("@cockpit-context/repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/repos")>()),
  scanKnownHost: vi.fn(),
  confirmKnownHost: vi.fn(),
  deleteKnownHost: vi.fn(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { knownHostsRouter } = await import("./known-hosts");

const db = prisma as unknown as { knownHost: { findMany: MockInstance } };
const scanKnownHost = repos.scanKnownHost as unknown as MockInstance;
const confirmKnownHost = repos.confirmKnownHost as unknown as MockInstance;
const deleteKnownHost = repos.deleteKnownHost as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");

const hostRow = {
  id: "kh-1",
  host: "git.example.com",
  port: 22,
  keyType: "ssh-ed25519",
  publicKey: "AAAAC3",
  fingerprint: "SHA256:xyz",
  createdAt: NOW,
  ownerId: "user-a",
};

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(knownHostsRouter, { context });
}

describe("knownHostsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).scan({ host: "x.example" })).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "UNAUTHORIZED",
    );
    expect(scanKnownHost).not.toHaveBeenCalled();
  });

  it("lists the pinned built-in hosts with their fingerprints, for signed-in users only", async () => {
    await expect(client(anonymousContext).pinned()).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "UNAUTHORIZED",
    );
    const { items } = await client().pinned();
    expect(items.map((item) => item.host)).toEqual(["github.com", "gitlab.com", "bitbucket.org"]);
    const github = items.find((item) => item.host === "github.com");
    expect(github?.port).toBe(22);
    expect(github?.keys).toContainEqual({
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    });
    expect(db.knownHost.findMany).not.toHaveBeenCalled();
  });

  it("lists the caller's hosts through the allowlisted projection", async () => {
    db.knownHost.findMany.mockResolvedValue([hostRow]);
    const result = await client().list({});
    const args = db.knownHost.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ AND: [{ ownerId: "user-a" }] });
    expect(args.select).toEqual(repos.knownHostSelect);
    expect(result.items[0]).not.toHaveProperty("ownerId");
  });

  it("scans through the git layer's address checks and returns fingerprints", async () => {
    scanKnownHost.mockResolvedValue({
      host: "git.example.com",
      port: 22,
      pinned: false,
      keys: [{ keyType: "ssh-ed25519", publicKey: "AAAAC3", fingerprint: "SHA256:xyz" }],
    });
    await expect(client().scan({ host: "git.example.com" })).resolves.toEqual({
      host: "git.example.com",
      port: 22,
      pinned: false,
      keys: [{ keyType: "ssh-ed25519", publicKey: "AAAAC3", fingerprint: "SHA256:xyz" }],
    });
    expect(scanKnownHost).toHaveBeenCalledWith({ host: "git.example.com", port: 22 });
  });

  it("maps a private address to its reason", async () => {
    scanKnownHost.mockRejectedValue(new repos.RepoError("PRIVATE_ADDRESS", "127.0.0.1"));
    await expect(client().scan({ host: "localhost" })).rejects.toSatisfy(
      (error: ORPCError<string, { reason: string }>) =>
        error.code === "BAD_REQUEST" && error.data.reason === "PRIVATE_ADDRESS",
    );
  });

  it("confirms under the caller's id", async () => {
    confirmKnownHost.mockResolvedValue(hostRow);
    await client().confirm({
      host: "git.example.com",
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3",
    });
    expect(confirmKnownHost).toHaveBeenCalledWith({
      ownerId: "user-a",
      host: "git.example.com",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3",
    });
  });

  it("deletes under the caller's id; a foreign id is NOT_FOUND", async () => {
    deleteKnownHost.mockRejectedValue(new repos.RepoError("KNOWN_HOST_NOT_FOUND", "nope"));
    await expect(client(sessionContext({ id: "user-b" })).delete({ id: "kh-1" })).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
    );
    expect(deleteKnownHost).toHaveBeenCalledWith({ ownerId: "user-b", id: "kh-1" });
  });
});
