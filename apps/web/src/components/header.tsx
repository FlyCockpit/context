import { cn } from "@cockpit-context/ui/lib/utils";
import { useParams } from "@tanstack/react-router";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { APP_HOME } from "@/lib/app-home";

import { AppNameLink } from "./app-name-link";
import { LanguageSwitcher } from "./language-switcher";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  // `strict: false` lets this component render under any route (including the
  // top-level `/` redirect) without throwing when the `lang` param is absent.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const { state } = useAuthSession();
  // Signed in, the wordmark goes to the signed-in home (APP_HOME); otherwise
  // to the public landing page.
  const home = state.status === "authenticated" ? APP_HOME : "/$lang";

  return (
    // `data-app-header`: what `pnpm check:shell-loading` measures, frame by
    // frame, from the first paint of a hard refresh to the loaded page.
    <header
      data-app-header=""
      className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="flex min-h-14 min-w-0 flex-row items-center gap-4 px-4 py-2">
        {/* The first thing in the row to give way (see AppNameLink). */}
        <AppNameLink to={home} lang={lang} />
        <MainNav />
        {/* Signed out (and while the session loads) nothing in the controls
            group can shrink, so it never does. Signed in, the account trigger
            is a fixed 44px below `md:` and its name truncates from `md:` up. */}
        <div
          className={cn(
            "ml-auto flex min-w-0 items-center gap-2",
            state.status !== "authenticated" && "shrink-0",
          )}
        >
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
