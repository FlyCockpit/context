import enNav from "@cockpit-context/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The header's account control in the ws-model-proxy shape. Signed out: Sign
 * up (open sign-up or the first-admin bootstrap) and Sign in, 44px named icon
 * buttons below `sm:` and text from `sm:`. Signed in: a 44px User icon below
 * `md:`, the name (capped, shrinking) from `md:`. Rendered to static markup,
 * so the widths are pinned through the breakpoint classes.
 */
const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  session: "anonymous" as "anonymous" | "authenticated" | "pending" | "error",
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    className,
    "aria-label": ariaLabel,
    children,
  }: {
    to: string;
    className?: string;
    "aria-label"?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} className={className ?? ""} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.config, isPending: fixture.config === undefined }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    meta: {},
    actions: {},
    state:
      fixture.session === "authenticated"
        ? {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada Lovelace" }, session: { id: "s1" } },
          }
        : { status: fixture.session },
  }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));

const { default: UserMenu } = await import("./user-menu");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = { signupOpen: false, adminBootstrapSignupEnabled: false };
  fixture.session = "anonymous";
});

const render = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UserMenu />
    </I18nextProvider>,
  );

function link(html: string, to: string) {
  const match = html.match(
    new RegExp(`<a data-to="${to.replace(/\$/g, "\\$")}" class="([^"]*)" aria-label="([^"]*)">`),
  );
  return match ? { classes: (match[1] ?? "").split(" "), label: match[2] } : undefined;
}

describe("signed-out account control", () => {
  it("is Sign in alone while sign-up is closed: a 44px named icon below sm:, text from sm:", () => {
    const html = render();
    expect(link(html, "/$lang/signup")).toBeUndefined();
    const signIn = link(html, "/$lang/login");
    expect(signIn?.label).toBe(enNav.userMenu.signIn);
    expect(signIn?.classes).toEqual(
      expect.arrayContaining(["h-11", "w-11", "px-0", "sm:w-auto", "sm:px-3.5"]),
    );
    expect(signIn?.classes).not.toContain("max-sm:hidden");
    expect(html).toContain('<span class="hidden sm:inline">Sign in</span>');
  });

  it("adds Sign up, also an icon below sm:, while open sign-up is on", () => {
    fixture.config = { signupOpen: true, adminBootstrapSignupEnabled: false };
    const signUp = link(render(), "/$lang/signup");
    expect(signUp?.label).toBe(enNav.userMenu.signUp);
    expect(signUp?.classes).toEqual(expect.arrayContaining(["h-11", "w-11", "sm:w-auto"]));
    expect(signUp?.classes).not.toContain("max-sm:hidden");
  });

  it("adds Sign up while only the first-admin bootstrap is open", () => {
    fixture.config = { signupOpen: false, adminBootstrapSignupEnabled: true };
    expect(link(render(), "/$lang/signup")).toBeDefined();
  });

  it("offers no Sign up under forced SSO, even with open sign-up or the first-admin bootstrap", () => {
    for (const config of [
      { forceSso: true, signupOpen: true, adminBootstrapSignupEnabled: false },
      { forceSso: true, signupOpen: false, adminBootstrapSignupEnabled: true },
    ]) {
      fixture.config = config;
      const html = render();
      expect(link(html, "/$lang/signup")).toBeUndefined();
      expect(link(html, "/$lang/login")).toBeDefined();
    }
  });

  it("never flashes Sign up while the config is still loading", () => {
    fixture.config = undefined;
    expect(link(render(), "/$lang/signup")).toBeUndefined();
  });
});

describe("signed-in account control", () => {
  it("is a 44px User icon below md: and the capped, shrinking name from md:", () => {
    fixture.session = "authenticated";
    const html = render();
    // The visible name starts the accessible name (WCAG 2.5.3).
    expect(html).toContain('aria-label="Ada Lovelace, account menu"');
    const classes = html.match(/<button[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(
      expect.arrayContaining(["w-11", "md:w-auto", "md:min-w-11", "md:max-w-48", "md:shrink"]),
    );
    expect(html).toContain('class="hidden truncate md:block">Ada Lovelace<');
  });

  it("shows a skeleton only while the first session loads", () => {
    for (const session of ["pending"] as const) {
      fixture.session = session;
      const html = render();
      expect(html).toContain('data-slot="skeleton"');
      expect(html).not.toContain("/$lang/login");
    }
  });
});
