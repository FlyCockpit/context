import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  authHandler: vi.fn(),
  withPasswordSignInFence: vi.fn(),
  withPasswordWriteLock: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../../packages/auth/src/password-sign-in-fence.js", () => ({
  withPasswordSignInFence: state.withPasswordSignInFence,
}));
vi.mock("../../../packages/auth/src/password-write-lock.js", () => ({
  PASSWORD_WRITE_PATHS: new Set(["/change-password", "/reset-password"]),
  withPasswordWriteLock: state.withPasswordWriteLock,
}));

const { handlePasswordAuthRequest } = await import("@cockpit-context/auth/password-auth-handler");
const app = new Hono();
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = source.indexOf('app.on(["POST", "GET"], "/api/auth/*",');
const end = source.indexOf("\n});", start) + "\n});".length;
if (start < 0 || end <= start) throw new Error("Better-Auth mount missing");
runInNewContext(source.slice(start, end), {
  app,
  auth: { handler: state.authHandler, api: { getSession: state.getSession } },
  Headers,
  Request,
  handlePasswordAuthRequest,
});
function request(path: string, init?: RequestInit) {
  return app.request(new Request(`https://app.example.test${path}`, init));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.getSession.mockResolvedValue({
    user: { id: "admin", role: "admin", emailVerified: true, twoFactorEnabled: true },
    session: { id: "cookie-session" },
  });
  state.authHandler.mockImplementation(() => new Response("auth ok"));
  state.order.length = 0;
  state.withPasswordSignInFence.mockImplementation(
    async (_request: Request, run: () => Promise<Response>) => {
      state.order.push("fence");
      const response = await run();
      state.order.push("recheck");
      return response;
    },
  );
  state.withPasswordWriteLock.mockImplementation(
    async (
      path: string,
      _request: Request,
      run: () => Promise<Response>,
      { getSession }: { getSession: (headers: Headers) => Promise<unknown> },
    ) => {
      state.order.push(`write-lock:${path}`);
      await getSession(new Headers());
      const response = await run();
      state.order.push("write-unlock");
      return response;
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("keeps environment loading before the shared password handler's validating imports", () => {
  expect(source.split("\n").find((line) => line.startsWith("import "))).toBe(
    'import "@cockpit-context/env/load-dotenv";',
  );
});

describe("/api/auth password sign-in", () => {
  it("runs the sign-in POST inside the credential fence, body intact and Authorization stripped", async () => {
    state.authHandler.mockImplementation(async (request: Request) => {
      state.order.push("handler");
      return Response.json({
        body: await request.json(),
        authorization: request.headers.get("authorization"),
      });
    });
    const body = { email: "a@example.test", password: "correct horse battery" };

    const res = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer untrusted" },
      body: JSON.stringify(body),
    });

    expect(await res.json()).toEqual({ body, authorization: null });
    expect(state.order).toEqual(["fence", "handler", "recheck"]);
    const [fenced] = state.withPasswordSignInFence.mock.calls[0] as [Request];
    expect(fenced.headers.get("authorization")).toBeNull();
  });

  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/two-factor/verify-totp"],
    ["POST", "/api/auth/request-password-reset"],
  ])("never fences %s %s", async (method, path) => {
    await request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "dc-1" }),
    });

    expect(state.authHandler).toHaveBeenCalledOnce();
    expect(state.withPasswordSignInFence).not.toHaveBeenCalled();
  });
});

describe("/api/auth password writes", () => {
  it.each(["/change-password", "/reset-password"])(
    "runs POST /api/auth%s inside the password-write lock, body intact and Authorization stripped",
    async (path) => {
      state.authHandler.mockImplementation(async (request: Request) => {
        state.order.push("handler");
        return Response.json({
          body: await request.json(),
          authorization: request.headers.get("authorization"),
        });
      });
      const body = { newPassword: "a-new-password-123", token: "t", userId: "u1" };

      const res = await request(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer untrusted" },
        body: JSON.stringify(body),
      });

      expect(await res.json()).toEqual({ body, authorization: null });
      expect(state.order).toEqual([`write-lock:${path}`, "handler", "write-unlock"]);
      const [, locked] = state.withPasswordWriteLock.mock.calls[0] as [string, Request];
      expect(locked.headers.get("authorization")).toBeNull();
      // The session lookup it is given is Better-Auth's.
      expect(state.getSession).toHaveBeenCalled();
    },
  );

  it.each([
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/two-factor/disable"],
    ["GET", "/api/auth/reset-password/tok"],
    ["GET", "/api/auth/reset-password"],
    ["GET", "/api/auth/change-password"],
    ["GET", "/api/auth/admin/set-user-password"],
    ["POST", "/api/auth/request-password-reset"],
  ])("never takes the password-write lock for %s %s", async (method, path) => {
    await request(path, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : {}),
    });
    expect(state.authHandler).toHaveBeenCalledOnce();
    expect(state.withPasswordWriteLock).not.toHaveBeenCalled();
  });
});
