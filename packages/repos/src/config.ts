import {
  type EncryptionKeyring,
  parseEncryptionKeyring,
} from "@cockpit-context/env/encryption-keyring";
import { COCKPIT_CONTEXT_DATA_DIR, env } from "@cockpit-context/env/server";

import { RepoError } from "./errors";

/** Absolute data root: bare clones, worktrees and per-invocation temp files. */
export function dataDir(): string {
  return COCKPIT_CONTEXT_DATA_DIR;
}

/** Branch/default-ref resolution re-fetches only when the last fetch is older than this. */
export function fetchIntervalMs(): number {
  return env.COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS * 1_000;
}

/**
 * `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST`: exact host names whose remotes may
 * resolve to internal (RFC 1918, CGNAT, unique-local) addresses. Parsed and
 * validated by the env schema; never user-settable.
 */
export function gitHostAllowlist(): readonly string[] {
  return env.COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST;
}

const BYTES_PER_GB = 1_000_000_000;

/** `COCKPIT_CONTEXT_MAX_STORAGE_GB` in bytes (decimal gigabytes, as disk sizes are sold). */
export function maxStorageBytes(): bigint {
  return BigInt(Math.floor(env.COCKPIT_CONTEXT_MAX_STORAGE_GB * BYTES_PER_GB));
}

let cachedKeyring: { raw: string; keyring: EncryptionKeyring } | null = null;

/**
 * The parsed `COCKPIT_CONTEXT_ENCRYPTION_KEYS` keyring. The env schema already checked
 * its shape at boot; a missing value is allowed outside production, so SSH
 * key features fail here with ENCRYPTION_UNAVAILABLE instead of at startup.
 */
export function encryptionKeyring(): EncryptionKeyring {
  const raw = env.COCKPIT_CONTEXT_ENCRYPTION_KEYS;
  if (!raw) {
    throw new RepoError(
      "ENCRYPTION_UNAVAILABLE",
      "COCKPIT_CONTEXT_ENCRYPTION_KEYS is not set, so SSH private keys cannot be stored or used.",
    );
  }
  if (cachedKeyring?.raw !== raw) {
    cachedKeyring = { raw, keyring: parseEncryptionKeyring(raw) };
  }
  return cachedKeyring.keyring;
}
