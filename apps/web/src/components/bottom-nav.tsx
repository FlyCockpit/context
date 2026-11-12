import { buttonVariants } from "@cockpit-context/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@cockpit-context/ui/components/sheet";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NavBadge } from "@/components/nav-badge";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useHomeStatus } from "@/hooks/use-home-status";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import {
  type AppNavId,
  getNavItems,
  moreNavIcon as MoreIcon,
  navBadgeCount,
  toLangRoute,
} from "@/lib/nav-items";

const NAV_CLASS =
  "fixed bottom-0 left-0 right-0 z-50 border-t bg-background/80 backdrop-blur-lg md:hidden";
const TAB_CLASS =
  "relative flex min-h-[44px] min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The one mobile nav bar: Ongoing · Conversations · Packages · Access · More
 * (a bottom sheet with Settings and, for admins, Admin). Signed-out visitors
 * get Home. Packages carries the pending-proposal badge.
 */
export default function BottomNav({ hidden }: { hidden?: boolean }) {
  // `strict: false` keeps this safe to render under any matched route (the
  // top-level `/` redirect leaves no `lang` param). Fall back to the default
  // locale rather than crashing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { t } = useTranslation(["nav", "common"]);
  const [moreOpen, setMoreOpen] = useState(false);
  // The one poller of `home.status`: the `_app` shell mounts this on every
  // page (CSS-hidden on desktop), so the sidebar and pages read its cache.
  const homeStatus = useHomeStatus({ poll: true });
  const session = authSession.state.status === "authenticated" ? authSession.state.session : null;
  const visible = { isAuthenticated: Boolean(session), role: session?.user.role };
  const tabs = getNavItems({ placement: "mobile", ...visible });
  const tabIds = new Set(tabs.map((item) => item.id));
  const rest = session
    ? getNavItems({ placement: "sidebar", ...visible }).filter((item) => !tabIds.has(item.id))
    : [];
  const badgeOf = (id: AppNavId) => navBadgeCount(id, homeStatus.data);
  const withBadge = (label: string, count: number) =>
    count > 0 ? `${label}, ${t("badge.pendingProposals", { count })}` : label;
  const moreBadge = rest.reduce((sum, item) => sum + badgeOf(item.id), 0);
  // On Settings or Admin the More tab is where you are, so it takes the active
  // color the other tabs get from their Link.
  const matchRoute = useMatchRoute();
  const moreActive = rest.some((item) =>
    Boolean(matchRoute({ to: toLangRoute(item.path), params: { lang }, fuzzy: !item.exact })),
  );

  if (hidden) return null;

  if (authSession.state.status === "pending" || authSession.state.status === "error") {
    return (
      <nav className={NAV_CLASS} style={{ paddingBottom: "var(--safe-area-bottom)" }}>
        <div className="flex h-14 items-center justify-around">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-14 rounded-md" />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav
      aria-label={t("mainNav.ariaLabel")}
      className={NAV_CLASS}
      style={{ paddingBottom: "var(--safe-area-bottom)" }}
    >
      <div className="flex h-14 items-center justify-around">
        {tabs.map((item) => {
          const label = t(item.labelKey);
          const badge = badgeOf(item.id);
          return (
            <Link
              key={item.id}
              to={toLangRoute(item.path)}
              params={{ lang }}
              activeOptions={{ exact: item.exact }}
              aria-label={withBadge(label, badge)}
              className={cn(TAB_CLASS, "not-data-[status=active]:text-muted-foreground")}
              activeProps={{ className: cn(TAB_CLASS, "text-primary-text") }}
            >
              <span className="relative">
                <item.icon aria-hidden="true" className="size-5" />
                <NavBadge count={badge} className="absolute -end-3 -top-2" />
              </span>
              <span className="text-[10px] font-medium leading-tight">{label}</span>
            </Link>
          );
        })}
        {rest.length > 0 ? (
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-label={withBadge(t("items.more"), moreBadge)}
              className={cn(TAB_CLASS, moreActive ? "text-primary-text" : "text-muted-foreground")}
              onClick={() => setMoreOpen(true)}
            >
              <span className="relative">
                <MoreIcon aria-hidden="true" className="size-5" />
                <NavBadge count={moreBadge} className="absolute -end-3 -top-2" />
              </span>
              <span className="text-[10px] font-medium leading-tight">{t("items.more")}</span>
            </button>
            <SheetContent
              closeLabel={t("common:actions.close")}
              side="bottom"
              className="max-h-[85dvh] overflow-x-hidden overflow-y-auto rounded-t-xl"
              style={{ paddingBottom: "var(--safe-area-bottom)" }}
            >
              <SheetHeader>
                <SheetTitle>{t("items.more")}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t("moreSheet.description")}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-1 px-4 pb-4">
                {rest.map((item) => (
                  <Link
                    key={item.id}
                    to={toLangRoute(item.path)}
                    params={{ lang }}
                    activeOptions={{ exact: item.exact }}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "touch" }),
                      "h-auto min-h-[52px] justify-start gap-3 py-2 not-data-[status=active]:text-muted-foreground",
                    )}
                    activeProps={{ className: "bg-muted text-foreground" }}
                  >
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="text-sm text-foreground">{t(item.labelKey)}</span>
                      {item.hintKey ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {t(item.hintKey)}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
    </nav>
  );
}
