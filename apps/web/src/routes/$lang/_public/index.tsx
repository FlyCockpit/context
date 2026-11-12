import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";

export const Route = createFileRoute("/$lang/_public/")({
  component: HomePage,
});

// Static landing copy. It lives in the `home.*` strings in
// packages/locales/src/<locale>/common.json.
function HomePage() {
  const { t } = useTranslation("common");
  const { lang } = Route.useParams();
  return (
    <PageShell width="narrow" className="py-16 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">{t("home.title")}</h1>
      <p className="mx-auto mt-4 max-w-md text-balance text-muted-foreground">
        {t("home.description")}
      </p>
      <Link
        to="/$lang/login"
        params={{ lang }}
        search={{ redirectTo: undefined }}
        className={cn(buttonVariants({ size: "touch" }), "mt-8 px-6")}
      >
        {t("home.signIn")}
      </Link>
    </PageShell>
  );
}
