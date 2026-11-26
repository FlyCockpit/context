import { Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConnectivityNotice } from "@/hooks/use-connectivity-notice";

/**
 * The app-wide offline band. Both shells render it in their top row, above
 * `<main>`, so it takes its own space in the flow: it never covers the page,
 * the BottomNav. See docs/ui.md § Offline and network failures.
 *
 * The live region is always mounted (empty while online), so assistive tech
 * announces "You're offline" once when it appears and "Back online" once on
 * reconnect. The fade is `motion-safe:` only.
 */
export function OfflineBand() {
  const notice = useConnectivityNotice();
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-offline-band="">
      {notice && (
        <p className="flex min-w-0 items-center gap-2 border-b bg-muted px-4 py-1.5 text-sm text-foreground motion-safe:animate-in motion-safe:fade-in-0">
          {notice === "offline" ? (
            <WifiOff aria-hidden="true" className="size-4 shrink-0 text-state-warning" />
          ) : (
            <Wifi aria-hidden="true" className="size-4 shrink-0 text-state-success" />
          )}
          <span className="min-w-0">
            {notice === "offline" ? t("offline.band") : t("offline.backOnline")}
          </span>
        </p>
      )}
    </div>
  );
}
