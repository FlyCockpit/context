import { generateKeyPairSync, randomUUID } from "node:crypto";

import prisma, { type Prisma } from "@cockpit-context/db";

import { encryptionKeyring } from "./config";
import { RepoError } from "./errors";
import { encodeEd25519 } from "./openssh";
import { decryptSshPrivateKey, encryptSshPrivateKey, sshKeyNeedsRotation } from "./ssh-key-crypto";
import { normalizeImportedPrivateKey } from "./ssh-tools";

/**
 * The SSH keys service (docs/product.md). Every function takes the owner id from the caller's verified
 * session and scopes every query by it.
 *
 * Disclosure boundary: `sshKeyPublicSelect` is the only projection that may
 * leave this module. `keyVersion`, `nonce`, `authTag` and `ciphertext` are
 * read only by `loadSshPrivateKey`, whose plaintext goes straight to a 0600
 * temp file for one git invocation.
 */

export const sshKeyPublicSelect = {
  id: true,
  name: true,
  source: true,
  algorithm: true,
  publicKey: true,
  fingerprint: true,
  createdAt: true,
  lastUsedAt: true,
} satisfies Prisma.SshKeySelect;

export type SshKeyView = Prisma.SshKeyGetPayload<{ select: typeof sshKeyPublicSelect }>;

const MAX_NAME_LENGTH = 100;
/** Comment written into generated public keys, so a deploy-key list shows where it came from. */
const KEY_COMMENT = "cockpit-context";

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new RepoError("SSH_KEY_INVALID", `Key names are 1-${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

async function storeKey(input: {
  ownerId: string;
  name: string;
  source: "GENERATED" | "IMPORTED";
  privateKey: string;
  algorithm: string;
  publicKeyLine: string;
  fingerprint: string;
}): Promise<SshKeyView> {
  const keyring = encryptionKeyring();
  // The id is minted here, not by the database, because it is bound into the
  // ciphertext's AAD before the row exists.
  const id = randomUUID();
  const encrypted = encryptSshPrivateKey(
    input.privateKey,
    { ownerId: input.ownerId, keyId: id },
    keyring,
  );
  try {
    return await prisma.sshKey.create({
      data: {
        id,
        ownerId: input.ownerId,
        name: input.name,
        source: input.source,
        algorithm: input.algorithm,
        publicKey: input.publicKeyLine,
        fingerprint: input.fingerprint,
        ...encrypted,
      },
      select: sshKeyPublicSelect,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RepoError("SSH_KEY_DUPLICATE", "You already have a key with this fingerprint.");
    }
    throw error;
  }
}

/** Generate an Ed25519 key pair; only the public half is returned. */
export async function generateSshKey(input: {
  ownerId: string;
  name: string;
}): Promise<SshKeyView> {
  const name = cleanName(input.name);
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) throw new Error("Ed25519 JWK export is missing key material.");
  const encoded = encodeEd25519(
    Buffer.from(jwk.d, "base64url"),
    Buffer.from(jwk.x, "base64url"),
    KEY_COMMENT,
  );
  return storeKey({
    ownerId: input.ownerId,
    name,
    source: "GENERATED",
    privateKey: encoded.privateKey,
    algorithm: encoded.publicKey.keyType,
    publicKeyLine: encoded.publicKeyLine,
    fingerprint: encoded.publicKey.fingerprint,
  });
}

/**
 * Import a pasted OpenSSH or PEM private key. It is validated by deriving its
 * public key; a passphrase-protected key is decrypted with the given
 * passphrase and stored re-encrypted under COCKPIT_CONTEXT_ENCRYPTION_KEYS only.
 */
export async function importSshKey(input: {
  ownerId: string;
  name: string;
  privateKey: string;
  passphrase?: string;
}): Promise<SshKeyView> {
  const name = cleanName(input.name);
  // Fail before touching ssh-keygen when the server cannot store keys at all.
  encryptionKeyring();
  const normalized = await normalizeImportedPrivateKey(
    input.privateKey,
    input.passphrase || undefined,
  );
  return storeKey({
    ownerId: input.ownerId,
    name,
    source: "IMPORTED",
    privateKey: normalized.privateKey,
    algorithm: normalized.publicKey.keyType,
    publicKeyLine: `${normalized.publicKey.keyType} ${normalized.publicKey.publicKey} ${KEY_COMMENT}`,
    fingerprint: normalized.publicKey.fingerprint,
  });
}

/** One page of the owner's keys, newest first. */
export async function listSshKeys(input: {
  ownerId: string;
  take: number;
  cursor?: string;
}): Promise<SshKeyView[]> {
  return prisma.sshKey.findMany({
    where: { ownerId: input.ownerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: sshKeyPublicSelect,
  });
}

export async function getSshKey(input: { ownerId: string; keyId: string }): Promise<SshKeyView> {
  const key = await prisma.sshKey.findFirst({
    where: { id: input.keyId, ownerId: input.ownerId },
    select: sshKeyPublicSelect,
  });
  if (!key) throw new RepoError("SSH_KEY_NOT_FOUND", "SSH key not found.");
  return key;
}

/** Delete an own key. Refused while a package still uses it. */
export async function deleteSshKey(input: { ownerId: string; keyId: string }): Promise<void> {
  await getSshKey(input);
  const inUse = await prisma.package.count({
    where: { ownerId: input.ownerId, sshKeyId: input.keyId },
  });
  if (inUse > 0) {
    throw new RepoError(
      "SSH_KEY_IN_USE",
      "This key is still used by a package; change that package first.",
    );
  }
  await prisma.sshKey.delete({ where: { id: input.keyId, ownerId: input.ownerId } });
}

const sshKeySecretSelect = {
  id: true,
  ownerId: true,
  keyVersion: true,
  nonce: true,
  authTag: true,
  ciphertext: true,
} satisfies Prisma.SshKeySelect;

/**
 * Decrypt an own key for one git/ssh invocation. Server-internal: never
 * return the result from a procedure. A row on an older keyring version is
 * re-encrypted under the current one (lazy rotation), guarded on the version
 * it was read with so a concurrent rotation cannot be overwritten.
 */
export async function loadSshPrivateKey(input: {
  ownerId: string;
  keyId: string;
}): Promise<string> {
  const row = await prisma.sshKey.findFirst({
    where: { id: input.keyId, ownerId: input.ownerId },
    select: sshKeySecretSelect,
  });
  if (!row) throw new RepoError("SSH_KEY_NOT_FOUND", "SSH key not found.");
  const keyring = encryptionKeyring();
  const identity = { ownerId: row.ownerId, keyId: row.id };
  const plaintext = decryptSshPrivateKey(row, identity, keyring);
  const now = new Date();
  if (sshKeyNeedsRotation(row, keyring)) {
    await prisma.sshKey.updateMany({
      where: { id: row.id, ownerId: row.ownerId, keyVersion: row.keyVersion },
      data: { ...encryptSshPrivateKey(plaintext, identity, keyring), lastUsedAt: now },
    });
  } else {
    await prisma.sshKey.update({
      where: { id: row.id },
      data: { lastUsedAt: now },
      select: { id: true },
    });
  }
  return plaintext;
}
