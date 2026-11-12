/**
 * Defense-in-depth redactor for MCP tool output (ported from
 * ws-model-proxy's `mcp/redaction.ts`). The tools' own projections are the
 * primary control; this only hides credential material that reached output
 * by mistake — a `cockpit_context_` token, a bearer/DPoP value or a JWT anywhere in a
 * string, and the value of any key that names a credential. Dependency
 * source is untrusted text and can contain such strings too, so answers pass
 * through here as well.
 *
 * Never throws; always returns a new value.
 */

/** Marker substituted for every redacted value. */
const MCP_REDACTED_VALUE = "[redacted]";

/** Normalized (lower case, no `_`/`-`) key names whose values are credentials. */
const CREDENTIAL_VALUE_KEYS: ReadonlySet<string> = new Set([
  "secret",
  "secretdigest",
  "tokendigest",
  "clientsecret",
  "password",
  "passwordhash",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "privatekey",
  "encryptedprivatekey",
  "ciphertext",
  "authtag",
  "nonce",
  "encryptionkey",
  "backupcodes",
  "bearertoken",
]);

function isCredentialValueKey(key: string): boolean {
  return CREDENTIAL_VALUE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** A `cockpit_context_` token: the prefix plus at least 20 base64url characters. */
const EMBEDDED_TOKEN = /cockpit_context_[A-Za-z0-9_-]{20,}/g;
/** `Bearer …` / `DPoP …` authorization values. */
const AUTHORIZATION_VALUE = /\b(?:Bearer|DPoP)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/** Compact JWS/JWT (three base64url segments, header starting `eyJ`). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function redactString(value: string): string {
  return value
    .replace(EMBEDDED_TOKEN, MCP_REDACTED_VALUE)
    .replace(AUTHORIZATION_VALUE, MCP_REDACTED_VALUE)
    .replace(JWT, MCP_REDACTED_VALUE);
}

const MAX_REDACTION_DEPTH = 24;

/** Recursively redact credential values and credential-value keys. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return MCP_REDACTED_VALUE;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    if (value instanceof Date || value instanceof Uint8Array) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isCredentialValueKey(key) ? MCP_REDACTED_VALUE : redactSecrets(entry, depth + 1);
    }
    return out;
  }
  return value;
}
