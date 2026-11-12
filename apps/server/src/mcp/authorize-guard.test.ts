import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const { createMcpAuthorizeGuard, inspectAuthorizeRequest } = await import("./authorize-guard");

const BASE = "https://cockpit-context.example.com";
const AUTHORIZE = "/api/auth/oauth2/authorize";
const CANONICAL = encodeURIComponent(`${BASE}/mcp`);
const FOREIGN = encodeURIComponent("https://foreign.example.com/mcp");

function buildApp() {
  const app = new Hono();
  const downstream = vi.fn(async () => new Response("downstream"));
  app.use(AUTHORIZE, createMcpAuthorizeGuard(BASE));
  app.on(["GET", "POST"], AUTHORIZE, downstream);
  return { app, downstream };
}

describe("createMcpAuthorizeGuard", () => {
  it("refuses a missing scope locally, never through the redirect_uri", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(
      `${AUTHORIZE}?resource=${CANONICAL}&client_id=a&redirect_uri=http://localhost:1/cb`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("refuses a missing or foreign resource with invalid_target", async () => {
    const { app, downstream } = buildApp();
    for (const query of ["scope=mcp", `scope=mcp&resource=${FOREIGN}`]) {
      const res = await app.request(`${AUTHORIZE}?${query}&client_id=a`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_target" });
    }
    expect(downstream).not.toHaveBeenCalled();
  });

  it("forwards a request naming this server's resource, unchanged", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(`${AUTHORIZE}?scope=mcp&resource=${CANONICAL}&client_id=a`);
    expect(await res.text()).toBe("downstream");
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("judges the last form value per key, as better-call does", async () => {
    const body = `scope=mcp&resource=${FOREIGN}&resource=${CANONICAL}`;
    const request = new Request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(await inspectAuthorizeRequest(request, BASE)).toBe("forward");
  });

  it("leaves percent-encoded spellings of the path to the downstream router", async () => {
    const app = new Hono();
    app.use("/api/auth/*", createMcpAuthorizeGuard(BASE));
    app.all("/api/auth/*", () => new Response("downstream"));
    const res = await app.request("/api/auth/oauth2/%61uthorize?client_id=a");
    expect(await res.text()).toBe("downstream");
  });
});
