import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EncryptionKeyring } from "@cockpit-context/env/encryption-keyring";

import { RepoError } from "./errors";

/**
 * AES-256-GCM at-rest encryption for SSH private keys, ported from
 * ws-model-proxy's `packages/api/src/lib/provider-credential-crypto.ts`.
 *
 * - The keyring is `COCKPIT_CONTEXT_ENCRYPTION_KEYS` (parsed by @cockpit-context/env): the first
 *   entry encrypts, every entry decrypts, so a key rotates by prepending.
 * - Each row stores `keyVersion`, a fresh 12-byte `nonce`, the 16-byte
 *   `authTag` and the `ciphertext`.
 * - The owner id and key id are bound as additional authenticated data, so a
 *   ciphertext copied onto another user's row (or another key row) fails to
 *   decrypt instead of handing that user someone else's key.
 */

const ALGORITHM = "aes-256-gcm";
const AAD_DOMAIN = "cockpit-context/ssh-private-key";
const AAD_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SshKeyIdentity {
  ownerId: string;
  keyId: string;
}

export interface EncryptedSshKey {
  keyVersion: string;
  nonce: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

function aad(identity: SshKeyIdentity): Buffer {
  if (!identity.ownerId || !identity.keyId) throw new Error("SSH key AAD needs owner and key ids.");
  // A JSON tuple is length-delimited by construction, so ("ab","c") and
  // ("a","bc") can never produce the same AAD.
  return Buffer.from(
    JSON.stringify([AAD_DOMAIN, AAD_VERSION, identity.ownerId, identity.keyId]),
    "utf8",
  );
}

export function encryptSshPrivateKey(
  plaintext: string,
  identity: SshKeyIdentity,
  keyring: EncryptionKeyring,
): EncryptedSshKey {
  if (plaintext.length === 0) throw new Error("SSH private key cannot be empty.");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.current.key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyVersion: keyring.current.version,
    nonce: Uint8Array.from(nonce),
    authTag: Uint8Array.from(cipher.getAuthTag()),
    ciphertext: Uint8Array.from(ciphertext),
  };
}

export function decryptSshPrivateKey(
  encrypted: EncryptedSshKey,
  identity: SshKeyIdentity,
  keyring: EncryptionKeyring,
): string {
  if (encrypted.nonce.byteLength !== NONCE_BYTES || encrypted.authTag.byteLength !== TAG_BYTES) {
    throw new RepoError("SSH_KEY_UNREADABLE", "The stored SSH key envelope is malformed.");
  }
  const key = keyring.byVersion.get(encrypted.keyVersion);
  if (!key) {
    throw new RepoError(
      "ENCRYPTION_UNAVAILABLE",
      `COCKPIT_CONTEXT_ENCRYPTION_KEYS has no entry for key version "${encrypted.keyVersion}".`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(encrypted.authTag);
  try {
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString(
      "utf8",
    );
  } catch (error) {
    // GCM authentication failed: a tampered row, a ciphertext moved onto
    // another owner's or key's row, or a keyring entry whose bytes changed
    // under the same version. No retry can fix it.
    throw new RepoError(
      "SSH_KEY_UNREADABLE",
      "The stored SSH key failed authentication and cannot be decrypted.",
      {},
      { cause: error },
    );
  }
}

/** True when the row was written with an older keyring entry and should be re-encrypted. */
export function sshKeyNeedsRotation(
  encrypted: Pick<EncryptedSshKey, "keyVersion">,
  keyring: EncryptionKeyring,
): boolean {
  return encrypted.keyVersion !== keyring.current.version;
}
