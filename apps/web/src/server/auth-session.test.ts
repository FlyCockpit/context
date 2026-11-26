import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasSessionTokenCookie, resolveRouteSessionFromAuth, toRouteSession } from "./auth-session";

const getSessionMock = vi.fn();

const fullSession = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    role: "admin",
    twoFactorEnabled: true,
    locale: "en-US",
    banned: false,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  },
  session: {
    id: "session-1",
    token: "secret-session-token",
    userId: "user-1",
    expiresAt: new Date("2026-02-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  },
};

describe("auth route session server helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a route-safe session shape without the session token", () => {
    expect(toRouteSession(fullSession)).toEqual({
      user: {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: true,
        createdAt: new Date("2026-01-01").getTime(),
        banned: false,
      },
    });
  });

  // Only the ban verdict crosses the boundary (never the reason or expiry);
  // the admin route guard refuses it, as checkAdminAuthority does.
  it("projects the ban verdict: active (permanent, future, cache-hit string) or lapsed", () => {
    const banned = (banExpires: Date | string | null) =>
      toRouteSession({ ...fullSession, user: { ...fullSession.user, banned: true, banExpires } })
        ?.user.banned;
    expect(banned(null)).toBe(true);
    expect(banned(new Date(Date.now() + 60_000))).toBe(true);
    expect(banned(new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(banned(new Date(Date.now() - 1000))).toBe(false);
    const projected = toRouteSession({
      ...fullSession,
      user: { ...fullSession.user, banned: true, banExpires: null },
    })?.user;
    expect(Object.keys(projected ?? {})).not.toContain("banExpires");
  });

  // `createdAt` crosses the createServerFn boundary, so it travels as epoch
  // milliseconds rather than a Date. The forced-2FA enrollment grace window is
  // measured from it; an unreadable value must become null, not NaN, so the
  // grace fails closed.
  it("normalizes an unreadable createdAt to null", () => {
    expect(
      toRouteSession({ ...fullSession, user: { ...fullSession.user, createdAt: "nope" } })?.user
        .createdAt,
    ).toBeNull();
    expect(
      toRouteSession({ ...fullSession, user: { ...fullSession.user, createdAt: undefined } })?.user
        .createdAt,
    ).toBeNull();
  });

  it("returns null for a confirmed anonymous request", () => {
    expect(toRouteSession(null)).toBeNull();
  });

  it("uses request headers when resolving the route session", async () => {
    const headers = new Headers({ cookie: "session=abc" });
    getSessionMock.mockResolvedValue(fullSession);

    await expect(resolveRouteSessionFromAuth(headers, getSessionMock)).resolves.toEqual({
      status: "resolved",
      session: {
        user: {
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
          emailVerified: true,
          role: "admin",
          twoFactorEnabled: true,
          createdAt: new Date("2026-01-01").getTime(),
          banned: false,
        },
      },
    });
    expect(getSessionMock).toHaveBeenCalledOnce();
    const call = getSessionMock.mock.calls[0]?.[0] as { headers: Headers } | undefined;
    expect(call?.headers.get("cookie")).toBe("session=abc");
  });

  it("resolves a confirmed anonymous request to a resolved null session", async () => {
    getSessionMock.mockResolvedValue(null);

    await expect(resolveRouteSessionFromAuth(new Headers(), getSessionMock)).resolves.toEqual({
      status: "resolved",
      session: null,
    });
  });

  it("does not convert auth transport failures into anonymous sessions", async () => {
    getSessionMock.mockRejectedValue(new Error("auth service unavailable"));

    await expect(resolveRouteSessionFromAuth(new Headers(), getSessionMock)).resolves.toEqual({
      status: "error",
    });
  });
});

describe("hasSessionTokenCookie (the public pages' presence-only hint)", () => {
  it("is true only for a non-empty Context session token cookie", () => {
    expect(hasSessionTokenCookie("cockpit-context.session_token=abc")).toBe(true);
    expect(hasSessionTokenCookie("a=1; __Secure-cockpit-context.session_token=abc; b=2")).toBe(
      true,
    );
    expect(hasSessionTokenCookie("cockpit-context.session_token=")).toBe(false);
    expect(hasSessionTokenCookie("cockpit-context.session_data=abc")).toBe(false);
    expect(hasSessionTokenCookie("better-auth.session_token=abc")).toBe(false);
    expect(hasSessionTokenCookie(null)).toBe(false);
    expect(hasSessionTokenCookie("")).toBe(false);
  });
});
