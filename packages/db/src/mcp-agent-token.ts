import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * MCP API token primitives (`McpAgentToken`, docs/mcp.md): the
 * plaintext format, the stored lookup prefix and the HMAC digest. Ported from
 * ws-model-proxy's `packages/db/src/node-security.ts` (agent tokens).
 *
 * - Plaintext: `cockpit_context_` + 32 random bytes, base64url. Shown once, never stored.
 * - `lookupPrefix`: the prefix plus the first 12 random characters (not secret;
 *   finds the row before the digest comparison).
 * - `secretDigest`: HMAC-SHA256 of the plaintext, hex, under a purpose key
 *   derived from `BETTER_AUTH_SECRET`, so a digest never verifies for another
 *   purpose and rotating that secret invalidates every token.
 *
 * Pure: the caller passes `BETTER_AUTH_SECRET` (`env.BETTER_AUTH_SECRET`).
 */

export const MCP_AGENT_TOKEN_PREFIX = "cockpit_context_";
const SECRET_BYTES = 32;
const VISIBLE_RANDOM_CHARS = 12;
const HMAC_CONTEXT = "cockpit-context:mcp-agent-token:v1";

export type MintedMcpAgentToken = {
  /** The plaintext `cockpit_context_…` token. Show it once; never store or log it. */
  token: string;
  lookupPrefix: string;
  secretDigest: string;
};

export function isMcpAgentToken(secret: string): boolean {
  return secret.startsWith(MCP_AGENT_TOKEN_PREFIX);
}

export function mcpAgentTokenLookupPrefix(token: string): string {
  return token.slice(0, MCP_AGENT_TOKEN_PREFIX.length + VISIBLE_RANDOM_CHARS);
}

export function mcpAgentTokenDigest(token: string, betterAuthSecret: string): string {
  const purposeKey = createHmac("sha256", Buffer.from(betterAuthSecret, "utf8"))
    .update(HMAC_CONTEXT)
    .digest();
  return createHmac("sha256", purposeKey).update(token).digest("hex");
}

/** Constant-time check of a presented token against a stored digest. */
export function verifyMcpAgentTokenDigest(
  token: string,
  secretDigest: string,
  betterAuthSecret: string,
): boolean {
  const candidate = Buffer.from(mcpAgentTokenDigest(token, betterAuthSecret), "utf8");
  const stored = Buffer.from(secretDigest, "utf8");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function mintMcpAgentToken(betterAuthSecret: string): MintedMcpAgentToken {
  const token = `${MCP_AGENT_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return {
    token,
    lookupPrefix: mcpAgentTokenLookupPrefix(token),
    secretDigest: mcpAgentTokenDigest(token, betterAuthSecret),
  };
}
