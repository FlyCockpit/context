import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ getRouteSession: vi.fn() }));
vi.mock("@/server/auth-session", () => ({ getRouteSession: server.getRouteSession }));

import { isDocumentReplaced, resetDocumentIdentityForTests } from "@/lib/document-identity";

import { resolveRouteSession } from "./route-session";

const reload = vi.fn();
const resolved = (id: string | null) => ({
  status: "resolved" as const,
  session: id === null ? null : { user: { id } },
});

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  reload.mockReset();
  server.getRouteSession.mockReset();
  vi.stubGlobal("window", { location: { reload } });
  // No server-rendered app shell in this document: the hydration wait
  // (lib/app-shell-hydration.ts, tested there) resolves at once.
  vi.stubGlobal("document", {
    documentElement: { style: { visibility: "" } },
    querySelector: () => null,
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Whether `promise` settles within a few task turns. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe("resolveRouteSession (every session guard: _auth, admin, the auth pages, mcp-consent)", () => {
  it("passes the server's answer through for this document's own identity", async () => {
    server.getRouteSession.mockResolvedValue(resolved("a"));
    await expect(resolveRouteSession()).resolves.toEqual(resolved("a"));
    await expect(resolveRouteSession()).resolves.toEqual(resolved("a"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("anonymous → signed in is admitted (an anonymous cache holds only public data)", async () => {
    server.getRouteSession.mockResolvedValueOnce(resolved(null));
    await resolveRouteSession();
    server.getRouteSession.mockResolvedValueOnce(resolved("a"));
    await expect(resolveRouteSession()).resolves.toEqual(resolved("a"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("another account replaces the document and never settles, so nothing renders A's data", async () => {
    server.getRouteSession.mockResolvedValueOnce(resolved("a"));
    await resolveRouteSession();
    server.getRouteSession.mockResolvedValueOnce(resolved("b"));
    expect(await settles(resolveRouteSession())).toBe(false);
    expect(isDocumentReplaced()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a sign-out confirmed by the guard replaces the document too", async () => {
    server.getRouteSession.mockResolvedValueOnce(resolved("a"));
    await resolveRouteSession();
    server.getRouteSession.mockResolvedValueOnce(resolved(null));
    expect(await settles(resolveRouteSession())).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a failed probe decides nothing", async () => {
    server.getRouteSession.mockResolvedValueOnce(resolved("a"));
    await resolveRouteSession();
    server.getRouteSession.mockResolvedValueOnce({ status: "error" });
    await expect(resolveRouteSession()).resolves.toEqual({ status: "error" });
    expect(reload).not.toHaveBeenCalled();
  });
});
