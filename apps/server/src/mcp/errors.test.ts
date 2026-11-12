import { describe, expect, it, vi } from "vitest";

import {
  mcpForbiddenResponse,
  mcpResourceMetadataUrl,
  mcpSanitizedLog,
  mcpUnauthorizedResponse,
} from "./errors";

describe("mcp errors", () => {
  it("points the 401 challenge at the RFC 9728 resource metadata", async () => {
    expect(mcpResourceMetadataUrl("https://cockpit-context.example.com/mcp")).toBe(
      "https://cockpit-context.example.com/.well-known/oauth-protected-resource/mcp",
    );
    const res = mcpUnauthorizedResponse({
      description: 'bad "token"',
      resourceUrl: "https://cockpit-context.example.com/mcp",
      scope: "mcp",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://cockpit-context.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp", error_description="bad \\"token\\""',
    );
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });

  it("sends no challenge on a 403", () => {
    expect(mcpForbiddenResponse().headers.get("www-authenticate")).toBeNull();
  });

  it("redacts log fields that carry URL or credential structure", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mcpSanitizedLog("rejected", {
      userId: "user-1",
      clientId: "https://client.example/meta.json?access_token=secret",
    });
    expect(error).toHaveBeenCalledWith("[mcp] rejected user=user-1 client=[redacted]");
    error.mockRestore();
  });
});
