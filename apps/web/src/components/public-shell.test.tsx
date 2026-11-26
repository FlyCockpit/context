import { type ComponentType, lazy, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";

/**
 * The shell rules, see docs/ui.md § Shell rules
 * They are rendered here, so a comment or a stray string cannot stand in for
 * the real markup. The geometry itself (footer bottom = scroller bottom,
 * full-bleed rules reach the viewport edge) is measured in a browser by
 * `pnpm check:layout`. Route components are code-split (`lazyRouteComponent`),
 * so route renders wait for the split chunk (`prerender`).
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <p>outlet</p>,
  redirect: () => undefined,
  useParams: () => "en-US",
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@cockpit-context/env/web", () => ({ env: { VITE_APP_NAME: "Cockpit Context" } }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/header", () => ({ default: () => null }));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ useReloadOnIdentityChange: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/i18n", () => ({ loadLocaleInto: async () => {} }));

const { PublicNotFoundPage, PublicShell } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");
const { Route: LangRoute } = await import("@/routes/$lang");

async function render(route: unknown): Promise<string> {
  const { component: Component } = (route as { options: { component: ComponentType } }).options;
  const { prelude } = await prerender(<Component />);
  return new Response(prelude).text();
}

function mainTag(html: string): string {
  const tags = html.match(/<main\b[^>]*>/g) ?? [];
  expect(tags, "exactly one <main> per shell").toHaveLength(1);
  return tags[0] ?? "";
}

// The scroller holds one column, at least as tall as the scroller: the page
// (growing) and then the footer, last.
const COLUMN =
  /<main\b[^>]*><div class="flex min-h-full min-w-0 flex-col"><div class="flex min-w-0 flex-1 flex-col">([\s\S]*)<\/div><footer\b[^>]*>[\s\S]*?<\/footer><\/div><\/main>/;

describe("public shell", () => {
  it("puts the footer after the page in a min-h-full column inside the one scroller", () => {
    const html = renderToStaticMarkup(
      <PublicShell>
        <p>page</p>
      </PublicShell>,
    );
    const match = html.match(COLUMN);
    expect(match, html).not.toBeNull();
    expect(match?.[1]).toBe("<p>page</p>");
    expect(html.match(/<footer\b/g)).toHaveLength(1);
    // check:layout finds the shell's footer by this marker, not by the first <footer> in <main>.
    expect(html).toMatch(/<footer\b[^>]*\bdata-public-footer=/);
    expect(html).toContain("<header");
  });

  it("the _public layout renders its routes through the shell", async () => {
    expect((await render(PublicRoute)).match(COLUMN)?.[1]).toBe("<p>outlet</p>");
  });

  it("the 404 for an unknown URL renders inside the public shell", async () => {
    // `$lang`'s notFoundComponent is code-split too: render it, then compare.
    const { notFoundComponent: NotFound } = (
      LangRoute as { options: { notFoundComponent?: ComponentType } }
    ).options;
    expect(NotFound, "$lang sets a notFoundComponent").toBeDefined();
    const html = renderToStaticMarkup(<PublicNotFoundPage />);
    if (NotFound) {
      const { prelude } = await prerender(<NotFound />);
      expect(await new Response(prelude).text()).toBe(html);
    }
    expect(html).toContain("<header");
    expect(html.match(COLUMN)?.[1]).toContain("pageNotFound.title");
  });

  it("the public footer carries the privacy notice link", async () => {
    const footer = (await render(PublicRoute)).match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    expect(footer).toContain("privacy:footerLink");
  });

  it("the public footer's bottom padding clears the bottom safe area (iOS home indicator)", async () => {
    const footer = (await render(PublicRoute)).match(/<footer\b[^>]*>/)?.[0];
    expect(footer).toContain("pb-[calc(1.5rem_+_var(--safe-area-bottom))]");
  });
});

describe("full-bleed rules inside the scroller", () => {
  it.each([
    ["public", PublicRoute],
    ["app", AppRoute],
  ])("the %s shell's scroller reserves no scrollbar gutter", async (_name, route) => {
    const tag = mainTag(await render(route));
    expect(tag).toContain('data-scroll-restoration-id="app-main"');
    expect(tag).toContain("overflow-y-auto");
    expect(tag).not.toContain("scrollbar-gutter");
  });

  it.each([
    ["public", PublicRoute],
    ["app", AppRoute],
  ])(
    "the %s shell puts the offline band in its top row, outside the scroller",
    async (_name, route) => {
      const html = await render(route);
      const band = html.search(/<div role="status"[^>]*data-offline-band=""/);
      expect(band, html).toBeGreaterThan(-1);
      expect(band).toBeLessThan(html.indexOf("<main"));
      expect(html.match(/data-offline-band=/g)).toHaveLength(1);
    },
  );

  it("the app shell has no footer (BottomNav on phones)", async () => {
    expect(await render(AppRoute)).not.toContain("<footer");
  });
});
