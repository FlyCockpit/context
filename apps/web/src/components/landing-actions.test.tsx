import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LandingActions } from "./landing-actions";

function links(entry: Parameters<typeof LandingActions>[0]["entry"]) {
  const html = renderToStaticMarkup(<LandingActions lang="en-US" entry={entry} />);
  return [...html.matchAll(/<a data-to="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
}

describe("LandingActions (CTX-08)", () => {
  it("offers only Sign in when nothing else applies", () => {
    expect(links(null)).toEqual([["/$lang/login", "home.signIn"]]);
  });

  it("leads with Set up this server while the bootstrap is open", () => {
    expect(links("setup")).toEqual([
      ["/$lang/signup", "home.setUp"],
      ["/$lang/login", "home.signIn"],
    ]);
  });

  it("says the server is invite-only under Sign in while sign-up is closed", () => {
    expect(links("invite-only")).toEqual([["/$lang/login", "home.signIn"]]);
    const html = renderToStaticMarkup(<LandingActions lang="en-US" entry="invite-only" />);
    expect(html).toContain("home.inviteOnly");
    expect(renderToStaticMarkup(<LandingActions lang="en-US" entry={null} />)).not.toContain(
      "home.inviteOnly",
    );
  });

  it("leads with Create account while open sign-up is on", () => {
    expect(links("signup")).toEqual([
      ["/$lang/signup", "home.createAccount"],
      ["/$lang/login", "home.signIn"],
    ]);
  });
});
