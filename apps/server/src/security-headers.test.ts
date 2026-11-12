import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders } from "./security-headers";

// Builds an app wired exactly like the real server: mountSecurityHeaders first,
// then the routes underneath it.
function buildApp(cspConnectSrc: string[] = ["'self'"]) {
  const app = new Hono();
  mountSecurityHeaders(app, {
    cspConnectSrc,
    themeInitCspHash: "'sha256-test'",
  });
  app.get("/some-page", (c) => c.text("page"));
  return app;
}

function directive(csp: string, name: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
  return (found ?? "").split(/\s+/).slice(1);
}

describe("mountSecurityHeaders", () => {
  it("serves the app CSP with the rest of the secureHeaders battery", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never allows 'unsafe-eval', 'wasm-unsafe-eval' or blob: in script-src", async () => {
    const res = await buildApp().request("/some-page");
    const scriptSrc = directive(res.headers.get("content-security-policy") ?? "", "script-src");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'sha256-test'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("blob:");
  });

  it("allows only same-origin workers", async () => {
    const res = await buildApp().request("/some-page");
    const workerSrc = directive(res.headers.get("content-security-policy") ?? "", "worker-src");
    expect(workerSrc).toEqual(["'self'"]);
  });

  it("emits the supplied connect-src list", async () => {
    const res = await buildApp(["'self'", "https://app.example.com"]).request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https://app.example.com");
  });
});
