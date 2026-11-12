import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createMcpDiscoveryForwarder, MCP_WELL_KNOWN_PATHS } from "./discovery";

function buildApp() {
  const handler = vi.fn(async (request: Request) =>
    Response.json({ url: request.url, method: request.method, host: request.headers.get("host") }),
  );
  const app = new Hono();
  for (const path of MCP_WELL_KNOWN_PATHS) {
    app.all(
      path,
      createMcpDiscoveryForwarder({ publicOrigin: "https://cockpit-context.example.com", handler }),
    );
  }
  return { app, handler };
}

describe("createMcpDiscoveryForwarder", () => {
  it("forwards GET on the configured public origin, whatever the Host header says", async () => {
    const { app } = buildApp();
    const res = await app.request("http://evil.example/.well-known/oauth-protected-resource/mcp", {
      headers: { host: "evil.example" },
    });
    expect(await res.json()).toMatchObject({
      url: "https://cockpit-context.example.com/.well-known/oauth-protected-resource/mcp",
      method: "GET",
    });
  });

  it("answers HEAD without a body and other methods with 405", async () => {
    const { app, handler } = buildApp();
    const head = await app.request("/.well-known/oauth-authorization-server/api/auth", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await app.request("/.well-known/oauth-protected-resource", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(handler).toHaveBeenCalledOnce();
  });
});
