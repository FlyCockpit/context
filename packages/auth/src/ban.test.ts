import { describe, expect, it } from "vitest";

import { isUserBanned } from "./ban";

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
