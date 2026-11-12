/**
 * Pure helpers for the local-dev `COCKPIT_CONTEXT_ENCRYPTION_KEYS` line in a root `.env`
 * file's contents.
 *
 * Cockpit Context encrypts SSH private keys at rest under this keyring, and production
 * refuses to boot without it. `pnpm run setup` mints a one-entry keyring
 * (`v1:<base64 32 bytes>`, format in packages/env/src/encryption-keyring.ts)
 * when the line is missing or empty, so a fresh clone can store keys from day
 * one. An existing value is never replaced: rotating it would make every
 * stored key unreadable.
 *
 * No file I/O here — `scripts/setup.ts` owns reading/writing the file. See
 * scripts/lib/encryption-keyring-env.test.ts.
 */

import { randomBytes } from "node:crypto";

const KEYRING_LINE = /^(\s*)#?\s*COCKPIT_CONTEXT_ENCRYPTION_KEYS\s*=/;

/** A fresh one-entry keyring. */
export function generateEncryptionKeyring(): string {
  return `v1:${randomBytes(32).toString("base64")}`;
}

/**
 * The active `COCKPIT_CONTEXT_ENCRYPTION_KEYS` value, or `null` when the line is absent,
 * commented out, or empty.
 */
export function readEncryptionKeyringValue(envContents: string): string | null {
  for (const raw of envContents.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const match = raw.match(/^\s*COCKPIT_CONTEXT_ENCRYPTION_KEYS\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Fill `COCKPIT_CONTEXT_ENCRYPTION_KEYS` with `keyring` when it has no value. The first
 * empty or commented template line is replaced in place; otherwise the line is
 * appended. Returns the input unchanged when a value is already set.
 */
export function withEncryptionKeyring(
  envContents: string,
  keyring: string = generateEncryptionKeyring(),
): string {
  if (readEncryptionKeyringValue(envContents) !== null) return envContents;

  const lines = envContents.split("\n");
  const index = lines.findIndex((line) => KEYRING_LINE.test(line));
  if (index !== -1) {
    const indent = lines[index]?.match(KEYRING_LINE)?.[1] ?? "";
    lines[index] = `${indent}COCKPIT_CONTEXT_ENCRYPTION_KEYS=${keyring}`;
    return lines.join("\n");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push(`COCKPIT_CONTEXT_ENCRYPTION_KEYS=${keyring}`, "");
  return lines.join("\n");
}
