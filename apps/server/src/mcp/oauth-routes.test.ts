import { cockpitContextRateBudgetEnvDefaults } from "@cockpit-context/env/rate-budgets";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@cockpit-context/env/server", () => ({
  env: {
    RATE_LIMIT_AUTH_POINTS: 30,
    RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
    RATE_LIMIT_EMAIL_POINTS: 3,
    RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
    // The MCP surfaces read their own COCKPIT_CONTEXT_MCP_*_PER_* counts at module load.
    ...cockpitContextRateBudgetEnvDefaults(),
  },
}));

const { isMcpOauthRateLimitedRequest } = await import("./oauth-routes");

async function decide(method: string, path: string) {
  const app = new Hono();
  let decision: boolean | undefined;
  app.all("*", (c) => {
    decision = isMcpOauthRateLimitedRequest(c);
    return c.text("ok");
  });
  await app.request(path, { method });
  return decision;
}

describe("isMcpOauthRateLimitedRequest", () => {
  it("matches the exact raw method and path only", async () => {
    expect(await decide("POST", "/api/auth/oauth2/token")).toBe(true);
    expect(await decide("GET", "/api/auth/oauth2/token")).toBe(false);
    expect(await decide("POST", "/api/%61uth/oauth2/token")).toBe(false);
    expect(await decide("POST", "/api/auth/sign-in/email")).toBe(false);
    expect(await decide("GET", "/api/auth/jwks")).toBe(true);
  });
});
