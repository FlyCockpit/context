import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { loggablePath, requestLog } from "./request-log.js";

describe("loggablePath", () => {
  it("drops the query string and fragment", () => {
    expect(loggablePath("https://app.example.com/api/auth/verify-email?token=abc&ok=1")).toBe(
      "/api/auth/verify-email",
    );
    expect(loggablePath("http://localhost:3000/en-US/mcp-login?sig=xyz#top")).toBe(
      "/en-US/mcp-login",
    );
  });

  it("redacts the password-reset token in the path", () => {
    expect(
      loggablePath("https://app.example.com/api/auth/reset-password/tok123?callbackURL=/x"),
    ).toBe("/api/auth/reset-password/[redacted]");
  });

  it("keeps ordinary paths", () => {
    expect(loggablePath("https://app.example.com/rpc/packages/list")).toBe("/rpc/packages/list");
    expect(loggablePath("https://app.example.com/")).toBe("/");
  });
});

describe("requestLog", () => {
  it("logs method, path, status and time without the query", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use(
      "/*",
      requestLog((line) => lines.push(line)),
    );
    app.get("/api/auth/verify-email", (c) => c.text("ok"));

    const response = await app.request("/api/auth/verify-email?token=secret-token");

    expect(response.status).toBe(200);
    expect(lines[0]).toBe("<-- GET /api/auth/verify-email");
    expect(lines[1]).toMatch(/^--> GET \/api\/auth\/verify-email 200 \d+m?s$/);
    expect(lines.join("\n")).not.toContain("secret-token");
  });
});
