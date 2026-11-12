import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal OpenSSH wire-format helpers: public key lines, SHA256 fingerprints,
 * and the `openssh-key-v1` private key container for generated Ed25519 keys.
 * Parsing of arbitrary imported private keys is delegated to `ssh-keygen`
 * (./ssh-keygen.ts), which handles every format and cipher OpenSSH does.
 */

/** Key types we store and accept from `ssh-keyscan` / imports. DSA is refused. */
const SUPPORTED_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const;
export type SupportedKeyType = (typeof SUPPORTED_KEY_TYPES)[number];

function isSupportedKeyType(value: string): value is SupportedKeyType {
  return (SUPPORTED_KEY_TYPES as readonly string[]).includes(value);
}

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

/** Read the leading SSH string (the key type) of a public key blob. */
function blobKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || 4 + length > blob.length) return null;
  return blob.subarray(4, 4 + length).toString("latin1");
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PublicKey {
  keyType: SupportedKeyType;
  /** Base64 blob as it appears in authorized_keys / known_hosts. */
  publicKey: string;
  /** `SHA256:<base64, no padding>`, as `ssh-keygen -l -E sha256` prints it. */
  fingerprint: string;
}

/** SHA256 fingerprint of a base64 key blob. */
export function fingerprintOf(base64Blob: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Blob, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * Validate a `keyType` + base64 blob pair: the base64 must be canonical, the
 * type supported, and the type embedded in the blob must match the claimed
 * one (so a scan result cannot be relabeled). Returns null when invalid.
 */
export function parsePublicKey(keyType: string, base64Blob: string): PublicKey | null {
  if (!isSupportedKeyType(keyType)) return null;
  if (base64Blob.length > 4_096 || !BASE64.test(base64Blob)) return null;
  const blob = Buffer.from(base64Blob, "base64");
  if (blob.toString("base64") !== base64Blob) return null;
  if (blobKeyType(blob) !== keyType) return null;
  return { keyType, publicKey: base64Blob, fingerprint: fingerprintOf(base64Blob) };
}

/** Parse a one-line OpenSSH public key (`type base64 [comment]`). */
export function parsePublicKeyLine(line: string): PublicKey | null {
  const [keyType = "", blob = ""] = line.trim().split(/\s+/);
  return parsePublicKey(keyType, blob);
}

/**
 * The PEM armor lines for `label` (`OPENSSH PRIVATE KEY` → `BEGIN …` / `END …`
 * between five dashes). Assembled from parts so the literal begin marker
 * appears in no tracked source file: `pnpm policy:template-secrets` rejects
 * every such line, and only a real committed key should trip it.
 */
export function pemArmor(label: string): { begin: string; end: string } {
  const dashes = "-".repeat(5);
  return { begin: `${dashes}BEGIN ${label}${dashes}`, end: `${dashes}END ${label}${dashes}` };
}

/** The armor of an `openssh-key-v1` private key. */
export const OPENSSH_PRIVATE_KEY_ARMOR = pemArmor("OPENSSH PRIVATE KEY");

export interface GeneratedEd25519 {
  /** An unencrypted `openssh-key-v1` container (`OPENSSH_PRIVATE_KEY_ARMOR`). */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment`. */
  publicKeyLine: string;
  publicKey: PublicKey;
}

/**
 * Serialize an Ed25519 key pair (32-byte seed + 32-byte public key, e.g. from
 * `generateKeyPairSync("ed25519")` exported as JWK) as an unencrypted
 * `openssh-key-v1` private key — the format `ssh-keygen -t ed25519` writes.
 */
export function encodeEd25519(seed: Buffer, publicKey: Buffer, comment: string): GeneratedEd25519 {
  if (seed.length !== 32 || publicKey.length !== 32) {
    throw new Error("Ed25519 keys are 32-byte seed + 32-byte public key.");
  }
  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicKey)]);
  const check = randomBytes(4).readUInt32BE(0);
  const unpadded = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ]);
  // Cipher "none" has an 8-byte block size; padding bytes are 1, 2, 3, …
  const padLength = (8 - (unpadded.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, index) => index + 1));
  const privateSection = Buffer.concat([unpadded, padding]);
  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const body =
    container
      .toString("base64")
      .match(/.{1,70}/g)
      ?.join("\n") ?? "";
  const { begin, end } = OPENSSH_PRIVATE_KEY_ARMOR;
  const privateKey = `${begin}\n${body}\n${end}\n`;
  const base64Blob = publicBlob.toString("base64");
  return {
    privateKey,
    publicKeyLine: `${keyType} ${base64Blob} ${comment}`,
    publicKey: { keyType, publicKey: base64Blob, fingerprint: fingerprintOf(base64Blob) },
  };
}
