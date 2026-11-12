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
  generateSshKey: vi.fn(),
  importSshKey: vi.fn(),
  deleteSshKey: vi.fn(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { sshKeysRouter } = await import("./ssh-keys");

const db = prisma as unknown as { sshKey: { findMany: MockInstance } };
const generateSshKey = repos.generateSshKey as unknown as MockInstance;
const importSshKey = repos.importSshKey as unknown as MockInstance;
const deleteSshKey = repos.deleteSshKey as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");
// Assembled from parts: `pnpm policy:template-secrets` rejects a literal
// private-key armor line anywhere in the tree.
const ARMOR_DASHES = "-".repeat(5);
const PRIVATE_KEY_INPUT = `${ARMOR_DASHES}BEGIN OPENSSH PRIVATE KEY${ARMOR_DASHES}\n...`;
const SECRET_FIELDS = ["keyVersion", "nonce", "authTag", "ciphertext"];

/** A row as a careless projection would return it: secrets included. */
function leakyRow() {
  return {
    id: "key-1",
    name: "deploy",
    source: "GENERATED",
    algorithm: "ssh-ed25519",
    publicKey: "ssh-ed25519 AAAA cockpit-context",
    fingerprint: "SHA256:abc",
    createdAt: NOW,
    lastUsedAt: null,
    ownerId: "user-a",
    keyVersion: "v1",
    nonce: Buffer.from("nonce"),
    authTag: Buffer.from("tag"),
    ciphertext: Buffer.from("PRIVATE KEY"),
  };
}

const PUBLIC_KEYS = [
  "algorithm",
  "createdAt",
  "fingerprint",
  "id",
  "lastUsedAt",
  "name",
  "publicKey",
  "source",
];

function client(context = sessionContext({ id: "user-a" })) {
  return createRouterClient(sshKeysRouter, { context });
}

describe("sshKeysRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session", async () => {
    await expect(client(anonymousContext).list({})).rejects.toSatisfy(
      (error: ORPCError<string, unknown>) => error.code === "UNAUTHORIZED",
    );
  });

  describe("list", () => {
    it("scopes to the caller and selects only public fields", async () => {
      db.sshKey.findMany.mockResolvedValue([leakyRow()]);
      const result = await client().list({});
      const args = db.sshKey.findMany.mock.calls[0]?.[0];
      expect(args.where).toEqual({ AND: [{ ownerId: "user-a" }] });
      expect(args.select).toEqual(repos.sshKeyPublicSelect);
      for (const field of SECRET_FIELDS) expect(args.select).not.toHaveProperty(field);
      // Even a row carrying secrets is serialized through the allowlist.
      expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(PUBLIC_KEYS);
      expect(result.items[0]?.source).toBe("generated");
    });
  });

  describe("generate", () => {
    it("generates under the caller and never returns key material", async () => {
      generateSshKey.mockResolvedValue(leakyRow());
      const result = await client().generate({ name: "deploy" });
      expect(generateSshKey).toHaveBeenCalledWith({ ownerId: "user-a", name: "deploy" });
      expect(Object.keys(result).sort()).toEqual(PUBLIC_KEYS);
    });
  });

  describe("import", () => {
    it("imports under the caller and never echoes the private key", async () => {
      importSshKey.mockResolvedValue({ ...leakyRow(), source: "IMPORTED" });
      const result = await client().import({
        name: "ci",
        privateKey: PRIVATE_KEY_INPUT,
        passphrase: "hunter2",
      });
      expect(importSshKey).toHaveBeenCalledWith({
        ownerId: "user-a",
        name: "ci",
        privateKey: PRIVATE_KEY_INPUT,
        passphrase: "hunter2",
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
      expect(Object.keys(result).sort()).toEqual(PUBLIC_KEYS);
    });

    it("maps a wrong passphrase to its reason without echoing input", async () => {
      importSshKey.mockRejectedValue(
        new repos.RepoError("SSH_KEY_PASSPHRASE_INVALID", "bad passphrase hunter2"),
      );
      await expect(
        client().import({ name: "ci", privateKey: "k", passphrase: "hunter2" }),
      ).rejects.toSatisfy((error: ORPCError<string, { reason: string }>) => {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.data.reason).toBe("SSH_KEY_PASSPHRASE_INVALID");
        expect(error.message).not.toContain("hunter2");
        return true;
      });
    });

    it.each(["SSH_KEY_PASSPHRASE_TOO_LONG", "SSH_KEY_PASSPHRASE_LINE_BREAK"] as const)(
      "maps %s to its own reason",
      async (code) => {
        importSshKey.mockRejectedValue(new repos.RepoError(code, "refused"));
        await expect(
          client().import({ name: "ci", privateKey: "k", passphrase: "hunter2" }),
        ).rejects.toSatisfy((error: ORPCError<string, { reason: string }>) => {
          expect(error.code).toBe("BAD_REQUEST");
          expect(error.data.reason).toBe(code);
          return true;
        });
      },
    );

    it.each(["a".repeat(1024), "ñ".repeat(512), "a".repeat(4096)])(
      "returns the byte-limit domain reason through the router",
      async (passphrase) => {
        const { normalizeImportedPrivateKey } = await import("../../../repos/src/ssh-tools");
        importSshKey.mockImplementation(({ privateKey, passphrase }) =>
          normalizeImportedPrivateKey(privateKey, passphrase),
        );
        await expect(
          client().import({ name: "ci", privateKey: PRIVATE_KEY_INPUT, passphrase }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          data: { reason: "SSH_KEY_PASSPHRASE_TOO_LONG" },
        });
        expect(importSshKey).toHaveBeenCalledOnce();
      },
    );

    it("bounds excessively large requests before calling the importer", async () => {
      await expect(
        client().import({ name: "ci", privateKey: "k", passphrase: "a".repeat(4097) }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(importSshKey).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes under the caller's id", async () => {
      deleteSshKey.mockResolvedValue(undefined);
      await expect(client().delete({ id: "key-1" })).resolves.toEqual({ ok: true });
      expect(deleteSshKey).toHaveBeenCalledWith({ ownerId: "user-a", keyId: "key-1" });
    });

    it("is NOT_FOUND for another user's key and CONFLICT for a key in use", async () => {
      deleteSshKey.mockRejectedValue(new repos.RepoError("SSH_KEY_NOT_FOUND", "nope"));
      await expect(
        client(sessionContext({ id: "user-b" })).delete({ id: "key-1" }),
      ).rejects.toSatisfy((error: ORPCError<string, unknown>) => error.code === "NOT_FOUND");
      expect(deleteSshKey).toHaveBeenCalledWith({ ownerId: "user-b", keyId: "key-1" });

      deleteSshKey.mockRejectedValue(new repos.RepoError("SSH_KEY_IN_USE", "in use"));
      await expect(client().delete({ id: "key-1" })).rejects.toSatisfy(
        (error: ORPCError<string, unknown>) => error.code === "CONFLICT",
      );
    });
  });
});
