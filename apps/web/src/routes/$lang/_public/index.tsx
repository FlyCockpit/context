import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LandingActions } from "@/components/landing-actions";
import { PageShell } from "@/components/page-shell";
import { landingEntry } from "@/lib/landing-entry";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/")({
  component: HomePage,
});

// Static landing copy. It lives in the `home.*` strings in
// packages/locales/src/<locale>/common.json.
function HomePage() {
  const { t } = useTranslation("common");
  const { lang } = Route.useParams();
  // Read on the client, so the server-rendered (and SSR-cached) HTML stays the
  // same for everyone: it offers "Sign in", and the setup or sign-up entry
  // joins it once the public config says which applies. A failed read keeps
  // "Sign in" alone; /login explains any setup state itself.
  const config = useQuery({
    ...orpc.appConfig.queryOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <PageShell width="narrow" className="py-16 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">{t("home.title")}</h1>
      <p className="mx-auto mt-4 max-w-md text-balance text-muted-foreground">
        {t("home.description")}
      </p>
      <LandingActions lang={lang} entry={landingEntry(config.data)} />
    </PageShell>
  );
}
