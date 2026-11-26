import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppNameLink } from "@/components/app-name-link";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import NotFoundState from "@/components/not-found-state";
import { OfflineBand } from "@/components/offline-band";
import { PublicFooter } from "@/components/public-footer";
import { SkipLink } from "@/components/skip-link";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

/**
 * The public shell: header, the one page scroller and the footer. The `_public`
 * layout renders its routes through it, and so does the 404 (`$lang`'s
 * `notFoundComponent`), so an unknown URL keeps the header's language and theme
 * controls, the footer and the scroller. See docs/ui.md § Shell rules
 */
export function PublicShell({ children }: { children: ReactNode }) {
  const lang = usePublicLang();
  return (
    // `html` and `body` never scroll (globals.css), so the public shell owns
    // its scroller like the app shell does: a fixed-height grid whose `main`
    // scrolls.
    <div
      className="grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]"
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      {/* The top row: header, then the offline band, which takes its own
          space above the scroller instead of covering the page. */}
      <div>
        <SkipLink />
        <PublicHeader lang={lang} />
        <OfflineBand />
      </div>
      {/* No `scrollbar-gutter: stable`: a reserved gutter stops the footer's
          and every other full-bleed rule inside the scroller short of the
          viewport edge with classic scrollbars. */}
      <main
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain"
      >
        {/* At least as tall as the scroller: the page grows into the space,
            so the footer ends at the scroller's bottom on a short page and
            follows the content on a long one. */}
        <div className="flex min-h-full min-w-0 flex-col">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <PublicFooter lang={lang} />
        </div>
      </main>
    </div>
  );
}

/**
 * `strict: false`: the 404 renders this shell under `$lang` as well as the
 * `_public` routes. An unsupported value never gets this far (`$lang`
 * redirects it), but fall back rather than build a broken link.
 */
function usePublicLang(): string {
  const langParam = useParams({ strict: false, select: (params) => params.lang });
  return isSupportedLocale(langParam) ? langParam : DEFAULT_LOCALE;
}

function PublicHeader({ lang }: { lang: string }) {
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
        <AppNameLink to="/$lang" lang={lang} />
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

/**
 * The 404 for an unknown URL, which matches no layout: `$lang`'s
 * `notFoundComponent`, so it renders in `$lang`'s outlet with nothing around
 * it. Wrapped in the public shell, it keeps the header (language, theme, Sign
 * in), the footer and the scroller like every other public page.
 */
export function PublicNotFoundPage() {
  return (
    <PublicShell>
      <NotFoundState />
    </PublicShell>
  );
}
