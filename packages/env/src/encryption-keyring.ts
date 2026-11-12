/**
 * The `COCKPIT_CONTEXT_ENCRYPTION_KEYS` keyring format, shared by the env schema (shape
 * check at boot) and the at-rest crypto that encrypts SSH private keys.
 *
 *   COCKPIT_CONTEXT_ENCRYPTION_KEYS=v2:<base64 32 bytes>,v1:<base64 32 bytes>
 *
 * The FIRST entry encrypts; every entry decrypts, so a key is rotated by
 * prepending a new version and keeping the old one until every row has been
 * lazily re-encrypted. Versions are short labels stored on each encrypted row.
 *
 * Pure and side-effect free (it lives beside `vars/`, which imports it). Error
 * messages never echo key material.
 */

/** Stored on every encrypted row, so keep it short and boring. */
const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Strict standard base64 with padding: exactly 44 characters for 32 bytes. */
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
export const ENCRYPTION_KEY_BYTES = 32;

export interface EncryptionKeyringEntry {
  version: string;
  key: Uint8Array;
}

export interface EncryptionKeyring {
  /** The entry new ciphertext is written with (the first one listed). */
  current: EncryptionKeyringEntry;
  /** Every entry, by version, for decryption. */
  byVersion: ReadonlyMap<string, Uint8Array>;
}

function decodeBase64Key(encoded: string): Uint8Array | null {
  if (!KEY_PATTERN.test(encoded)) return null;
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return bytes.length === ENCRYPTION_KEY_BYTES ? bytes : null;
}

/**
 * Parse a keyring string. Throws an Error naming the offending entry by
 * position and version — never by value — when the shape is wrong.
 */
export function parseEncryptionKeyring(raw: string): EncryptionKeyring {
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (entries.length === 0) {
    throw new Error(
      "COCKPIT_CONTEXT_ENCRYPTION_KEYS is empty; expected `v1:<base64 32-byte key>`.",
    );
  }

  const parsed: EncryptionKeyringEntry[] = entries.map((entry, index) => {
    const separator = entry.indexOf(":");
    const version = separator === -1 ? "" : entry.slice(0, separator);
    const where = `COCKPIT_CONTEXT_ENCRYPTION_KEYS entry ${index + 1}`;
    if (!VERSION_PATTERN.test(version)) {
      throw new Error(
        `${where} must look like \`<version>:<base64 key>\` with a version of 1-32 letters, digits, \`_\` or \`-\`.`,
      );
    }
    const key = decodeBase64Key(entry.slice(separator + 1));
    if (!key) {
      throw new Error(
        `${where} (version "${version}") is not a base64-encoded ${ENCRYPTION_KEY_BYTES}-byte key. ` +
          "Generate one with `openssl rand -base64 32`.",
      );
    }
    return { version, key };
  });

  const byVersion = new Map<string, Uint8Array>();
  for (const { version, key } of parsed) {
    if (byVersion.has(version)) {
      throw new Error(
        `COCKPIT_CONTEXT_ENCRYPTION_KEYS repeats version "${version}"; every version must be unique.`,
      );
    }
    byVersion.set(version, key);
  }

  const [current] = parsed;
  if (!current) {
    throw new Error(
      "COCKPIT_CONTEXT_ENCRYPTION_KEYS is empty; expected `v1:<base64 32-byte key>`.",
    );
  }
  return { current, byVersion };
}

/** True when `raw` parses; for Zod refinements that must not throw. */
export function isValidEncryptionKeyring(raw: string): boolean {
  try {
    parseEncryptionKeyring(raw);
    return true;
  } catch {
    return false;
  }
}
