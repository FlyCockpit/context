import { parseEncryptionKeyring } from "@cockpit-context/env/encryption-keyring";
import { describe, expect, it } from "vitest";

import { OPENSSH_PRIVATE_KEY_ARMOR } from "./openssh";
import { decryptSshPrivateKey, encryptSshPrivateKey, sshKeyNeedsRotation } from "./ssh-key-crypto";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const identity = { ownerId: "user-1", keyId: "key-1" };
const plaintext = `${OPENSSH_PRIVATE_KEY_ARMOR.begin}\nsecret\n${OPENSSH_PRIVATE_KEY_ARMOR.end}\n`;

describe("encryptSshPrivateKey / decryptSshPrivateKey", () => {
  const keyring = parseEncryptionKeyring(`v1:${KEY_A}`);

  it("round-trips and never stores the plaintext", () => {
    const encrypted = encryptSshPrivateKey(plaintext, identity, keyring);
    expect(encrypted.keyVersion).toBe("v1");
    expect(encrypted.nonce.byteLength).toBe(12);
    expect(encrypted.authTag.byteLength).toBe(16);
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain("secret");
    expect(decryptSshPrivateKey(encrypted, identity, keyring)).toBe(plaintext);
  });

  it("uses a fresh nonce per encryption", () => {
    const a = encryptSshPrivateKey(plaintext, identity, keyring);
    const b = encryptSshPrivateKey(plaintext, identity, keyring);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
  });

  it("binds the owner and key ids: a ciphertext moved to another row fails", () => {
    const encrypted = encryptSshPrivateKey(plaintext, identity, keyring);
    expect(() =>
      decryptSshPrivateKey(encrypted, { ...identity, ownerId: "user-2" }, keyring),
    ).toThrow(expect.objectContaining({ code: "SSH_KEY_UNREADABLE", permanent: true }));
    expect(() => decryptSshPrivateKey(encrypted, { ...identity, keyId: "key-2" }, keyring)).toThrow(
      expect.objectContaining({ code: "SSH_KEY_UNREADABLE" }),
    );
  });

  it("detects tampering", () => {
    const encrypted = encryptSshPrivateKey(plaintext, identity, keyring);
    const ciphertext = Uint8Array.from(encrypted.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptSshPrivateKey({ ...encrypted, ciphertext }, identity, keyring)).toThrow(
      expect.objectContaining({ code: "SSH_KEY_UNREADABLE" }),
    );
  });

  it("decrypts old versions after rotation and flags them for re-encryption", () => {
    const old = encryptSshPrivateKey(plaintext, identity, keyring);
    const rotated = parseEncryptionKeyring(`v2:${KEY_B},v1:${KEY_A}`);
    expect(decryptSshPrivateKey(old, identity, rotated)).toBe(plaintext);
    expect(sshKeyNeedsRotation(old, rotated)).toBe(true);
    const fresh = encryptSshPrivateKey(plaintext, identity, rotated);
    expect(fresh.keyVersion).toBe("v2");
    expect(sshKeyNeedsRotation(fresh, rotated)).toBe(false);
  });

  it("reports a version the keyring no longer has", () => {
    const old = encryptSshPrivateKey(plaintext, identity, keyring);
    expect(() =>
      decryptSshPrivateKey(old, identity, parseEncryptionKeyring(`v2:${KEY_B}`)),
    ).toThrow(expect.objectContaining({ code: "ENCRYPTION_UNAVAILABLE" }));
  });
});
