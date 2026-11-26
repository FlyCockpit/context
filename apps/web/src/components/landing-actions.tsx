import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import type { LandingEntry } from "@/lib/landing-entry";

/**
 * The landing hero's entry points: "Sign in" always, led by "Set up this
 * server" while the first-admin bootstrap is open or "Create account" while
 * open sign-up is on (`landingEntry`). Both of those go to /signup, which
 * shows the matching form.
 */
export function LandingActions({ lang, entry }: { lang: string; entry: LandingEntry }) {
  const { t } = useTranslation("common");
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      {entry ? (
        <Link
          to="/$lang/signup"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          className={cn(buttonVariants({ size: "touch" }), "px-6")}
        >
          {entry === "setup" ? t("home.setUp") : t("home.createAccount")}
        </Link>
      ) : null}
      <Link
        to="/$lang/login"
        params={{ lang }}
        search={{ redirectTo: undefined }}
        className={cn(
          buttonVariants({ size: "touch", variant: entry ? "outline" : "default" }),
          "px-6",
        )}
      >
        {t("home.signIn")}
      </Link>
    </div>
  );
}
