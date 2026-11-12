import { parseEncryptionKeyring } from "@cockpit-context/env/encryption-keyring";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const state = vi.hoisted(() => ({ keyring: "" }));
vi.mock("./config", async () => {
  const { parseEncryptionKeyring: parse } = await import("@cockpit-context/env/encryption-keyring");
  return { encryptionKeyring: () => parse(state.keyring), dataDir: () => "/unused" };
});

const normalizeMock = vi.hoisted(() => vi.fn());
vi.mock("./ssh-tools", () => ({ normalizeImportedPrivateKey: normalizeMock }));

const { default: prisma } = await import("@cockpit-context/db");
const { decryptSshPrivateKey, encryptSshPrivateKey } = await import("./ssh-key-crypto");
const sshKeys = await import("./ssh-keys");
const { OPENSSH_PRIVATE_KEY_ARMOR } = await import("./openssh");

const db = prisma as unknown as {
  sshKey: {
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    delete: MockInstance;
  };
  package: { count: MockInstance };
};

const SECRET_FIELDS = ["keyVersion", "nonce", "authTag", "ciphertext"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  state.keyring = `v1:${KEY_A}`;
});

describe("sshKeyPublicSelect", () => {
  it("never selects the encrypted private key", () => {
    for (const field of SECRET_FIELDS)
      expect(Object.keys(sshKeys.sshKeyPublicSelect)).not.toContain(field);
  });
});

describe("generateSshKey", () => {
  it("stores the private half encrypted with owner+id AAD and returns only the public projection", async () => {
    db.sshKey.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: args.data.id,
      name: args.data.name,
    }));
    await sshKeys.generateSshKey({ ownerId: "user-1", name: "  Deploy key  " });

    const args = db.sshKey.create.mock.calls[0]?.[0] as {
      data: {
        id: string;
        ownerId: string;
        name: string;
        source: string;
        algorithm: string;
        publicKey: string;
        fingerprint: string;
        keyVersion: string;
        nonce: Uint8Array<ArrayBuffer>;
        authTag: Uint8Array<ArrayBuffer>;
        ciphertext: Uint8Array<ArrayBuffer>;
      };
      select: unknown;
    };
    expect(args.select).toBe(sshKeys.sshKeyPublicSelect);
    expect(args.data).toMatchObject({
      ownerId: "user-1",
      name: "Deploy key",
      source: "GENERATED",
      algorithm: "ssh-ed25519",
      keyVersion: "v1",
    });
    expect(args.data.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ cockpit-context$/);
    expect(args.data.fingerprint).toMatch(/^SHA256:/);
    const plaintext = decryptSshPrivateKey(
      args.data,
      { ownerId: "user-1", keyId: args.data.id },
      parseEncryptionKeyring(state.keyring),
    );
    expect(plaintext.startsWith(OPENSSH_PRIVATE_KEY_ARMOR.begin)).toBe(true);
    expect(Buffer.from(args.data.ciphertext).toString("utf8")).not.toContain("OPENSSH");
  });

  it("maps a duplicate fingerprint to SSH_KEY_DUPLICATE", async () => {
    db.sshKey.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(sshKeys.generateSshKey({ ownerId: "user-1", name: "k" })).rejects.toMatchObject({
      code: "SSH_KEY_DUPLICATE",
    });
  });

  it("fails cleanly without a keyring", async () => {
    // The mocked config parses an empty keyring, which throws like the real one.
    state.keyring = "";
    await expect(sshKeys.generateSshKey({ ownerId: "user-1", name: "k" })).rejects.toThrow();
    expect(db.sshKey.create).not.toHaveBeenCalled();
  });
});

describe("importSshKey", () => {
  it("stores the normalized key and a cockpit-context-commented public line", async () => {
    normalizeMock.mockResolvedValue({
      privateKey: `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nx\n${OPENSSH_PRIVATE_KEY_ARMOR.end}\n`,
      publicKey: { keyType: "ssh-rsa", publicKey: "AAAAB3Nza", fingerprint: "SHA256:abc" },
    });
    db.sshKey.create.mockResolvedValue({ id: "k" });
    await sshKeys.importSshKey({
      ownerId: "user-1",
      name: "ci",
      privateKey: "pasted",
      passphrase: "",
    });
    expect(normalizeMock).toHaveBeenCalledWith("pasted", undefined);
    expect(db.sshKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "IMPORTED",
          algorithm: "ssh-rsa",
          publicKey: "ssh-rsa AAAAB3Nza cockpit-context",
          fingerprint: "SHA256:abc",
        }),
        select: sshKeys.sshKeyPublicSelect,
      }),
    );
  });
});

describe("listSshKeys / getSshKey", () => {
  it("scopes by owner, bounds the page and uses the public projection", async () => {
    db.sshKey.findMany.mockResolvedValue([]);
    await sshKeys.listSshKeys({ ownerId: "user-1", take: 21, cursor: "c1" });
    expect(db.sshKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user-1" },
        take: 21,
        cursor: { id: "c1" },
        skip: 1,
        select: sshKeys.sshKeyPublicSelect,
      }),
    );
  });

  it("is NOT_FOUND for someone else's key", async () => {
    db.sshKey.findFirst.mockResolvedValue(null);
    await expect(sshKeys.getSshKey({ ownerId: "user-1", keyId: "k" })).rejects.toMatchObject({
      code: "SSH_KEY_NOT_FOUND",
    });
    expect(db.sshKey.findFirst).toHaveBeenCalledWith({
      where: { id: "k", ownerId: "user-1" },
      select: sshKeys.sshKeyPublicSelect,
    });
  });
});

describe("deleteSshKey", () => {
  it("refuses a key still used by a package", async () => {
    db.sshKey.findFirst.mockResolvedValue({ id: "k" });
    db.package.count.mockResolvedValue(1);
    await expect(sshKeys.deleteSshKey({ ownerId: "user-1", keyId: "k" })).rejects.toMatchObject({
      code: "SSH_KEY_IN_USE",
    });
    expect(db.sshKey.delete).not.toHaveBeenCalled();
  });

  it("deletes an unused own key, owner-scoped", async () => {
    db.sshKey.findFirst.mockResolvedValue({ id: "k" });
    db.package.count.mockResolvedValue(0);
    await sshKeys.deleteSshKey({ ownerId: "user-1", keyId: "k" });
    expect(db.sshKey.delete).toHaveBeenCalledWith({ where: { id: "k", ownerId: "user-1" } });
  });
});

describe("loadSshPrivateKey", () => {
  const identity = { ownerId: "user-1", keyId: "key-1" };
  const plaintext = `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nsecret\n`;

  it("decrypts and touches lastUsedAt", async () => {
    const encrypted = encryptSshPrivateKey(
      plaintext,
      identity,
      parseEncryptionKeyring(state.keyring),
    );
    db.sshKey.findFirst.mockResolvedValue({ id: "key-1", ownerId: "user-1", ...encrypted });
    await expect(sshKeys.loadSshPrivateKey(identity)).resolves.toBe(plaintext);
    expect(db.sshKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "key-1", ownerId: "user-1" } }),
    );
    expect(db.sshKey.updateMany).not.toHaveBeenCalled();
    expect(db.sshKey.update).toHaveBeenCalledOnce();
  });

  it("re-encrypts a row on an old key version, guarded on that version", async () => {
    const encrypted = encryptSshPrivateKey(
      plaintext,
      identity,
      parseEncryptionKeyring(state.keyring),
    );
    state.keyring = `v2:${KEY_B},v1:${KEY_A}`;
    db.sshKey.findFirst.mockResolvedValue({ id: "key-1", ownerId: "user-1", ...encrypted });
    await expect(sshKeys.loadSshPrivateKey(identity)).resolves.toBe(plaintext);
    const args = db.sshKey.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: {
        keyVersion: string;
        nonce: Uint8Array<ArrayBuffer>;
        authTag: Uint8Array<ArrayBuffer>;
        ciphertext: Uint8Array<ArrayBuffer>;
      };
    };
    expect(args.where).toEqual({ id: "key-1", ownerId: "user-1", keyVersion: "v1" });
    expect(args.data.keyVersion).toBe("v2");
    expect(decryptSshPrivateKey(args.data, identity, parseEncryptionKeyring(`v2:${KEY_B}`))).toBe(
      plaintext,
    );
  });

  it("is NOT_FOUND for someone else's key", async () => {
    db.sshKey.findFirst.mockResolvedValue(null);
    await expect(sshKeys.loadSshPrivateKey(identity)).rejects.toMatchObject({
      code: "SSH_KEY_NOT_FOUND",
    });
  });
});
