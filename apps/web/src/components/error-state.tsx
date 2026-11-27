import { Button } from "@cockpit-context/ui/components/button";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { AlertTriangle, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { useRetryOnReconnect } from "@/hooks/use-retry-on-reconnect";
import { markRouteIdentityUnconfirmed } from "@/lib/document-identity";
import { isFetchFailure } from "@/lib/network-failure";

import { friendly } from "../utils/friendly-error";

/**
 * The router's default error boundary. Offline it says so and loads the page
 * by itself on reconnect; a fetch that failed while online says the server
 * could not be reached; anything else is the generic error. See
 * docs/ui.md § Offline and network failures.
 */
export default function ErrorState({ error }: ErrorComponentProps) {
  const { t } = useTranslation(["common", "errors"]);
  const router = useRouter();
  const online = useNetworkStatus();
  // `invalidate` reloads the failed matches (a failed route chunk included)
  // and gives them new identities, which resets this boundary.
  // Hold successful ancestors pending before recovering a child boundary.
  // Every recovery reruns guards before private route context can render.
  const retry = () => {
    const confirmRecovery = markRouteIdentityUnconfirmed();
    void router
      .invalidate({ forcePending: true })
      .then(confirmRecovery)
      .catch(() => {});
  };
  useRetryOnReconnect(retry, !online);

  if (!online || isFetchFailure(error)) {
    const title = online ? t("errors:unreachablePage.title") : t("errors:offlinePage.title");
    const description = online
      ? t("errors:unreachablePage.description")
      : t("errors:offlinePage.description");
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <WifiOff aria-hidden="true" className="size-8 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-base font-medium">{title}</p>
          <p className="text-sm text-muted-foreground break-words">{description}</p>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={retry} variant="outline" className="min-h-[44px]">
            {t("common:actions.tryAgain")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <AlertTriangle className="size-8 text-destructive" />
      <div className="space-y-1">
        <p className="text-base font-medium">{t("common:somethingWentWrong")}</p>
        <p className="text-sm text-muted-foreground break-words">
          {friendly(error, t("errors:rootError"))}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button size="touch" onClick={retry} variant="outline">
          {t("common:actions.tryAgain")}
        </Button>
        <Button onClick={() => window.location.reload()} className="min-h-[44px]">
          {t("common:actions.reload")}
        </Button>
      </div>
    </div>
  );
}
