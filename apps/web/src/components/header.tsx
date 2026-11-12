import { Link, useParams } from "@tanstack/react-router";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

import { BrandMark } from "./brand-mark";
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
  // Signed in, the wordmark goes to the app's home (Ongoing); otherwise to the
  // public landing page.
  const home = state.status === "authenticated" ? "/$lang/ongoing" : "/$lang";

  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex min-h-14 min-w-0 flex-row items-center gap-4 px-4 py-2">
        <Link
          to={home}
          params={{ lang }}
          className="inline-flex min-h-11 min-w-0 max-w-48 shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56 lg:max-w-none"
        >
          <BrandMark />
        </Link>
        <MainNav />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
