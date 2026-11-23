import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wordmark is the first thing in both header rows to give way, at every
 * width, so a long name or locale cannot push the controls past the trailing
 * line; signed out, the controls group never shrinks. Rendered to static
 * markup (no layout), so the contract is pinned through the classes; the real
 * widths are checked in a browser at 320, 360, 390 and 1280.
 */
const fixture = vi.hoisted(() => ({
  session: "anonymous" as "anonymous" | "authenticated" | "pending",
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    className,
    title,
    children,
  }: {
    to: string;
    className?: string;
    title?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} className={className ?? ""} title={title}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: fixture.session } }),
}));
vi.mock("@cockpit-context/env/web", () => ({ env: { VITE_APP_NAME: "Cockpit Context" } }));
vi.mock("./main-nav", () => ({ MainNav: () => <nav /> }));
vi.mock("./language-switcher", () => ({
  LanguageSwitcher: () => <span data-control="language" />,
}));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => <span data-control="theme" /> }));
vi.mock("./user-menu", () => ({ default: () => <span data-control="account" /> }));

const { default: Header } = await import("./header");
const { AppNameLink } = await import("./app-name-link");

function classesOf(html: string, marker: RegExp): string[] {
  const match = marker.exec(html);
  if (!match?.[1]) throw new Error(`no match for ${marker}`);
  return match[1].split(/\s+/);
}

describe("AppNameLink", () => {
  it("takes only the room the row leaves it, down to a 44px target, with the full name as its title", () => {
    const html = renderToStaticMarkup(<AppNameLink to="/$lang" lang="en-US" />);
    const link = classesOf(html, /<a data-to="\/\$lang" class="([^"]*)"/);
    expect(link).toEqual(expect.arrayContaining(["basis-0", "grow", "max-w-fit", "min-w-11"]));
    expect(link).not.toContain("shrink-0");
    expect(html).toContain('title="Cockpit Context"');
    // The name truncates inside its caps, so a long name keeps the MainNav's room.
    const name = classesOf(html, /<span class="([^"]*truncate[^"]*)">Cockpit Context<\/span>/);
    expect(name).toEqual(expect.arrayContaining(["max-w-40", "sm:max-w-56", "lg:max-w-80"]));
  });
});

describe("Header", () => {
  beforeEach(() => {
    fixture.session = "anonymous";
  });

  it("signed out (and while the session loads) never shrinks the controls group", () => {
    for (const session of ["anonymous", "pending"] as const) {
      fixture.session = session;
      const html = renderToStaticMarkup(<Header />);
      expect(html).toContain('data-to="/$lang"');
      const group = classesOf(html, /<div class="(ml-auto[^"]*)"/);
      expect(group).toContain("shrink-0");
    }
  });

  it("signed in links the wordmark to the app home and lets the group shrink", () => {
    fixture.session = "authenticated";
    const html = renderToStaticMarkup(<Header />);
    expect(html).toContain('data-to="/$lang/ongoing"');
    const group = classesOf(html, /<div class="(ml-auto[^"]*)"/);
    expect(group).not.toContain("shrink-0");
  });
});
