import { describe, expect, it } from "vitest";

import {
  accessNavItems,
  getNavItems,
  navBadgeCount,
  stripLangPrefix,
  toLangRoute,
} from "./nav-items";

const paths = (input: Parameters<typeof getNavItems>[0]) =>
  getNavItems(input).map((item) => item.path);

describe("nav-items", () => {
  it("shows signed-out visitors only the public home", () => {
    expect(paths({ placement: "desktop", isAuthenticated: false })).toEqual(["/"]);
    expect(paths({ placement: "mobile", isAuthenticated: false })).toEqual(["/"]);
    expect(paths({ placement: "sidebar", isAuthenticated: false })).toEqual([]);
    expect(paths({ placement: "userMenu", isAuthenticated: false })).toEqual([]);
  });

  it("keeps the header nav empty for signed-in users (the sidebar is their nav)", () => {
    expect(paths({ placement: "desktop", isAuthenticated: true, role: "user" })).toEqual([]);
  });

  it("lists the app sections in sidebar order for users", () => {
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "user" })).toEqual([
      "/ongoing",
      "/conversations",
      "/packages",
      "/access",
      "/settings",
    ]);
  });

  it("groups the sidebar into main sections and a footer", () => {
    const items = getNavItems({ placement: "sidebar", isAuthenticated: true, role: "admin" });
    expect(items.filter((item) => item.group === "main").map((item) => item.id)).toEqual([
      "ongoing",
      "conversations",
      "packages",
      "access",
    ]);
    expect(items.filter((item) => item.group === "footer").map((item) => item.id)).toEqual([
      "settings",
      "admin",
    ]);
  });

  it("adds admin destinations only when the shared admin role helper matches", () => {
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "manager" })).not.toContain(
      "/admin",
    );
    expect(paths({ placement: "sidebar", isAuthenticated: true, role: "user, admin" })).toContain(
      "/admin",
    );
    expect(paths({ placement: "userMenu", isAuthenticated: true, role: "user" })).toEqual([
      "/settings",
    ]);
    expect(paths({ placement: "userMenu", isAuthenticated: true, role: "admin" })).toEqual([
      "/settings",
      "/admin",
    ]);
  });

  it("keeps the mobile tab bar to four tabs and leaves the rest for More", () => {
    const tabs = paths({ placement: "mobile", isAuthenticated: true, role: "admin" });
    expect(tabs).toEqual(["/ongoing", "/conversations", "/packages", "/access"]);
    const more = paths({ placement: "sidebar", isAuthenticated: true, role: "admin" }).filter(
      (path) => !tabs.includes(path),
    );
    expect(more).toEqual(["/settings", "/admin"]);
  });

  it("gives every section a label and a hint key", () => {
    for (const item of getNavItems({
      placement: "sidebar",
      isAuthenticated: true,
      role: "admin",
    })) {
      expect(item.labelKey).toBe(`items.${item.id}`);
      expect(item.hintKey).toBe(`hints.${item.id}`);
    }
  });

  it("badges Packages with the pending proposal count only", () => {
    expect(navBadgeCount("packages", { pendingProposals: 3 })).toBe(3);
    expect(navBadgeCount("packages", undefined)).toBe(0);
    expect(navBadgeCount("ongoing", { pendingProposals: 3 })).toBe(0);
  });

  it("builds typed locale-prefixed routes", () => {
    expect(toLangRoute("/")).toBe("/$lang");
    expect(toLangRoute("/ongoing")).toBe("/$lang/ongoing");
    expect(toLangRoute("/access/ssh-keys")).toBe("/$lang/access/ssh-keys");
  });

  it("orders the access tabs left to right", () => {
    expect(accessNavItems.map((item) => item.path)).toEqual([
      "/access/tokens",
      "/access/connections",
      "/access/ssh-keys",
      "/access/known-hosts",
    ]);
  });

  it("strips the locale prefix from top-level routes", () => {
    expect(stripLangPrefix("/en-US/ongoing")).toBe("/ongoing");
  });

  it("returns root when only the locale segment is present", () => {
    expect(stripLangPrefix("/en-US")).toBe("/");
    expect(stripLangPrefix("/en-US/")).toBe("/");
  });

  it("preserves nested segments after stripping the locale prefix", () => {
    expect(stripLangPrefix("/en-US/settings/privacy")).toBe("/settings/privacy");
  });
});
