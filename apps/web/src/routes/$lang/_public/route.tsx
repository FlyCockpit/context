import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BrandMark } from "@/components/brand-mark";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import { PublicFooter } from "@/components/public-footer";
import { SkipLink } from "@/components/skip-link";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

export const Route = createFileRoute("/$lang/_public")({
  component: PublicLayout,
});

function PublicLayout() {
  const { lang } = Route.useParams();
  return (
    // `html` and `body` never scroll (globals.css), so the public shell owns
    // its scroller like the app shell does: a fixed-height grid whose `main`
    // scrolls, with the footer at the end of the scrolled content.
    <div
      className="grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]"
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      <div>
        <SkipLink />
        <PublicHeader />
      </div>
      <main
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
      >
        <div className="flex-1">
          <Outlet />
        </div>
        <PublicFooter lang={lang} />
      </main>
    </div>
  );
}

function PublicHeader() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("nav");
  // Deliberately always the logged-out nav: public pages stay fully static —
  // no session fetch, no better-auth chunk, SSR HTML identical for everyone.
  // The Sign in link below is the static auth entry point that comes with
  // that choice. Known tradeoff: a signed-in user's server-side locale
  // preference can't redirect these pages (that would need a session fetch);
  // it applies once they enter the `_app` branch (`useUserLocaleSync`). To
  // make this header session-aware instead, see
  // docs/development.md § Change workflow.
  const items = getNavItems({ placement: "desktop", isAuthenticated: false });

  return (
    <header>
      <div className="flex min-w-0 flex-row items-center gap-4 px-4 py-2">
        <Link
          to="/$lang"
          params={{ lang }}
          className="inline-flex min-h-11 min-w-0 max-w-48 shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56 lg:max-w-none"
        >
          <BrandMark />
        </Link>
        {/* Hidden below `sm`: the public branch has no BottomNav, its only
            destination is Home, and the wordmark already links there, so a
            390px phone spends the row on language, theme and Sign in instead. */}
        <nav
          aria-label={t("mainNav.ariaLabel")}
          className="hidden min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar sm:block"
        >
          <div className="flex w-max items-center gap-1">
            {items.map((item) => (
              <Link
                key={item.id}
                to={toLangRoute(item.path)}
                params={{ lang }}
                activeOptions={{ exact: item.exact }}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium not-data-[status=active]:text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-9"
                activeProps={{
                  className: "bg-muted text-foreground",
                }}
              >
                <item.icon aria-hidden="true" className="size-4" />
                <span>{t(item.labelKey)}</span>
              </Link>
            ))}
          </div>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants({ size: "touch", variant: "outline" }))}
          >
            {t("userMenu.signIn")}
          </Link>
        </div>
      </div>
      <hr />
    </header>
  );
}
