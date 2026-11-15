import { describe, expect, it, vi } from "vitest";

import { announceIfUserBanned, announceUserBanned, isUserBanned, onUserBanned } from "./ban";

describe("isUserBanned", () => {
  it("is false for a user who was never banned", () => {
    expect(isUserBanned({ banned: false, banExpires: null })).toBe(false);
    expect(isUserBanned({})).toBe(false);
    expect(isUserBanned({ banned: null })).toBe(false);
  });

  it("is true for a permanent ban", () => {
    // `banExpires: null` on a banned user is what `users.archive` writes.
    expect(isUserBanned({ banned: true, banExpires: null })).toBe(true);
    expect(isUserBanned({ banned: true })).toBe(true);
  });

  it("is true while a temporary ban is in force and false once it lapses", () => {
    expect(isUserBanned({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isUserBanned({ banned: true, banExpires: new Date(Date.now() - 60_000) })).toBe(false);
  });

  it("accepts an ISO string for banExpires, as the cookie cache hands it over", () => {
    // The regression this guards: on a Better-Auth cookie-cache HIT the session
    // user is revived from base64(JSON) and only createdAt/updatedAt become
    // Dates (`better-auth/dist/api/routes/session.mjs:110-114`), so banExpires
    // arrives as a string. Calling `.getTime()` on it threw a TypeError, which
    // for a LAPSED ban — where the answer should be "allow" — turned a
    // legitimate admin's request into a 500 until the cache expired.
    expect(
      isUserBanned({ banned: true, banExpires: new Date(Date.now() + 60_000).toISOString() }),
    ).toBe(true);
    expect(
      isUserBanned({ banned: true, banExpires: new Date(Date.now() - 60_000).toISOString() }),
    ).toBe(false);
  });

  it("stays banned when banExpires is unparseable", () => {
    // Fail closed: this predicate only ever gates access.
    expect(isUserBanned({ banned: true, banExpires: "not-a-date" })).toBe(true);
  });
});

describe("ban announcements", () => {
  it("reaches every listener, even after one throws, and stops after unsubscribe", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    const stopFirst = onUserBanned(first);
    const stopSecond = onUserBanned(second);
    try {
      announceUserBanned("u-1");
      expect(first).toHaveBeenCalledWith("u-1", "application");
      expect(second).toHaveBeenCalledWith("u-1", "application");
      expect(error).toHaveBeenCalledOnce();
    } finally {
      stopFirst();
      stopSecond();
      error.mockRestore();
    }
    announceUserBanned("u-2");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("announceIfUserBanned announces only a ban in force", () => {
    const listener = vi.fn();
    const stop = onUserBanned(listener);
    try {
      announceIfUserBanned({ id: "a", banned: false });
      announceIfUserBanned({ id: "b", banned: true, banExpires: new Date(Date.now() - 1_000) });
      announceIfUserBanned({ id: "c", banned: true, banExpires: null });
    } finally {
      stop();
    }
    // The admin plugin path: listeners learn it stopped nothing itself.
    expect(listener.mock.calls).toEqual([["c", "auth-plugin"]]);
  });
});
