import { readFileSync } from "node:fs";
import { APP_LOCALE_HEADER } from "@cockpit-context/config/locales";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";

import { CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS } from "./cors-headers";

const APP_ORIGIN = "https://app.example.com";

// Mirrors the cross-origin branch in index.ts. Asserting against the real
// middleware rather than the constant is the point: a header missing from
// CORS_ALLOW_HEADERS is only observable as a preflight that fails to echo it
// back, which is exactly what the browser refuses on.
function buildApp() {
  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: APP_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      exposeHeaders: [...CORS_EXPOSE_HEADERS],
      credentials: true,
    }),
  );
  app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
  app.get("/api/auth/get-session", (c) => {
    c.header("Retry-After", "12");
    return c.json({ code: "TOO_MANY_REQUESTS" }, 429);
  });
  return app;
}

function preflight(requestHeaders: string) {
  return buildApp().request("/api/auth/sign-in/email", {
    method: "OPTIONS",
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders,
    },
  });
}

describe("CORS_ALLOW_HEADERS", () => {
  it.each([...CORS_ALLOW_HEADERS])("echoes %s back on the preflight", async (header) => {
    const res = await preflight(header);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(header.toLowerCase());
  });

  it("allows the locale header the auth client sets on every request", async () => {
    // Regression guard. apps/web/src/lib/auth-client.ts sets APP_LOCALE_HEADER
    // in `onRequest`, so it rides along on sign-in, sign-up, and get-session.
    // Omitting it from allowHeaders fails the preflight and blocks all three —
    // but only when CORS_ORIGIN is set, so local dev and CI never see it and
    // the breakage lands on the first split-origin production deploy.
    expect(CORS_ALLOW_HEADERS).toContain(APP_LOCALE_HEADER);

    const res = await preflight(`content-type,${APP_LOCALE_HEADER}`);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(APP_LOCALE_HEADER);
  });

  it("allows the CSRF header Better-Auth's client plugin sets", async () => {
    const res = await preflight("x-csrf-token");
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-csrf-token");
  });
});

describe("CORS_EXPOSE_HEADERS", () => {
  it("lets credentialed split-origin session clients read Retry-After on a 429", async () => {
    const response = await buildApp().request("/api/auth/get-session", {
      headers: { Origin: APP_ORIGIN, Cookie: "better-auth.session_token=test" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const exposed = (response.headers.get("Access-Control-Expose-Headers") ?? "")
      .toLowerCase()
      .split(/\s*,\s*/);
    expect(exposed).toContain("retry-after");
    expect(response.headers.get("Retry-After")).toBe("12");
  });

  it("wires the response-header contract into the server CORS middleware", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.includes("exposeHeaders: [...CORS_EXPOSE_HEADERS]")).toBe(true);
  });
});
