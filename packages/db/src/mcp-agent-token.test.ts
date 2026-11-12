import { describe, expect, it } from "vitest";

import {
  isMcpAgentToken,
  MCP_AGENT_TOKEN_PREFIX,
  mcpAgentTokenDigest,
  mcpAgentTokenLookupPrefix,
  mintMcpAgentToken,
  verifyMcpAgentTokenDigest,
} from "./mcp-agent-token";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);

describe("mintMcpAgentToken", () => {
  it("mints a cockpit_context_ token whose prefix and digest match the helpers", () => {
    const minted = mintMcpAgentToken(SECRET);
    expect(minted.token.startsWith(MCP_AGENT_TOKEN_PREFIX)).toBe(true);
    expect(isMcpAgentToken(minted.token)).toBe(true);
    // 32 random bytes in base64url are 43 characters.
    expect(minted.token).toHaveLength(MCP_AGENT_TOKEN_PREFIX.length + 43);
    expect(minted.lookupPrefix).toBe(mcpAgentTokenLookupPrefix(minted.token));
    expect(minted.lookupPrefix).toHaveLength(MCP_AGENT_TOKEN_PREFIX.length + 12);
    expect(minted.secretDigest).toBe(mcpAgentTokenDigest(minted.token, SECRET));
    expect(minted.secretDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores the plaintext in the prefix or digest", () => {
    const minted = mintMcpAgentToken(SECRET);
    expect(minted.secretDigest).not.toContain(minted.token);
    expect(minted.token.startsWith(minted.lookupPrefix)).toBe(true);
    expect(minted.lookupPrefix.length).toBeLessThan(minted.token.length);
  });

  it("mints a different token every time", () => {
    expect(mintMcpAgentToken(SECRET).token).not.toBe(mintMcpAgentToken(SECRET).token);
  });
});

describe("verifyMcpAgentTokenDigest", () => {
  it("accepts the token it was minted for", () => {
    const minted = mintMcpAgentToken(SECRET);
    expect(verifyMcpAgentTokenDigest(minted.token, minted.secretDigest, SECRET)).toBe(true);
  });

  it("rejects another token, another secret and a malformed digest", () => {
    const minted = mintMcpAgentToken(SECRET);
    const other = mintMcpAgentToken(SECRET);
    expect(verifyMcpAgentTokenDigest(other.token, minted.secretDigest, SECRET)).toBe(false);
    expect(verifyMcpAgentTokenDigest(minted.token, minted.secretDigest, OTHER_SECRET)).toBe(false);
    expect(verifyMcpAgentTokenDigest(minted.token, "short", SECRET)).toBe(false);
  });

  it("is not a plain SHA-256 of the token (the purpose key is derived)", () => {
    expect(mcpAgentTokenDigest("cockpit_context_x", SECRET)).not.toBe(
      mcpAgentTokenDigest("cockpit_context_x", OTHER_SECRET),
    );
  });
});
