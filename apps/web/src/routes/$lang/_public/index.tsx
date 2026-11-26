import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LandingActions } from "@/components/landing-actions";
import { PageShell } from "@/components/page-shell";
import { APP_HOME } from "@/lib/app-home";
import { landingEntry } from "@/lib/landing-entry";
import { ensureSessionHint } from "@/lib/session-hint";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/")({
  // A visitor who is probably signed in (a session cookie is present) goes
  // straight to the signed-in home: the landing is for people without an
  // account or signed out. Presence only, never an access check: a stale
  // cookie lands on the home's `_auth` gate, which sends them to sign-in.
  // The `_public` layout's beforeLoad already put the hint in the query
  // cache, so this is a cache read, not a second server call; a failed hint
  // reads as signed out and the landing shows (lib/session-hint.ts). An
  // anonymous render stays static and cacheable; ssr-cache.ts never caches a
  // cookie-bearing request, and only 200s, so the redirect is never replayed.
  beforeLoad: async ({ params, context }) => {
    const signedIn = await ensureSessionHint(context.queryClient);
    if (signedIn) {
      throw redirect({ to: APP_HOME, params: { lang: params.lang }, replace: true });
    }
  },
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
