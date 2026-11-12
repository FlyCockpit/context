import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/auth/auth-screen";

/**
 * What /login and /signup show while no administrator exists, instead of a
 * dead-end form: how the operator finishes setup (docs/deploy.md § First administrator: private access before public exposure).
 * `bootstrap` (login only) points at the first-admin signup.
 */
export function AdminSetupCard({
  state,
  lang,
  redirectTo,
}: {
  /** `appConfig.adminSetup`: non-null only while the server has no administrator. */
  state: "bootstrap" | "configure" | "locked";
  lang: string;
  redirectTo: string | undefined;
}) {
  const { t } = useTranslation(["auth"]);
  if (state === "bootstrap") {
    return (
      <AuthCard
        title={t("auth:adminSetup.bootstrapTitle")}
        description={t("auth:adminSetup.bootstrapDescription")}
      >
        <Link
          to="/$lang/signup"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:adminSetup.bootstrapAction")}
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title={t(
        state === "locked" ? "auth:adminSetup.lockedTitle" : "auth:adminSetup.configureTitle",
      )}
      description={t(
        state === "locked"
          ? "auth:adminSetup.lockedDescription"
          : "auth:adminSetup.configureDescription",
      )}
    >
      <p className="text-sm text-muted-foreground">{t("auth:adminSetup.operatorHint")}</p>
    </AuthCard>
  );
}
