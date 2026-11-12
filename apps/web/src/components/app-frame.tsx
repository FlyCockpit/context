import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { NavBadge } from "@/components/nav-badge";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useHomeStatus } from "@/hooks/use-home-status";
import { type AppNavItem, getNavItems, navBadgeCount, toLangRoute } from "@/lib/nav-items";
import { useUiPreferences } from "@/stores/ui-preferences";

/**
 * The signed-in app frame: a collapsible desktop sidebar (main sections, then
 * Settings and Admin in the footer group) beside the page. Below `md` the
 * BottomNav and its More sheet are the only navigation. The `_app` shell owns
 * safe areas, the header and the page scroller (`main`, a size container, so
 * the sidebar can stick at `100cqh`); pages own their own container.
 */
export function AppFrame({ lang, children }: { lang: string; children: ReactNode }) {
  const { t } = useTranslation(["nav"]);
  const { state } = useAuthSession();
  const session = state.status === "authenticated" ? state.session : null;
  const sidebarCollapsed = useUiPreferences((prefs) => prefs.sidebarCollapsed);
  const toggleSidebar = useUiPreferences((prefs) => prefs.toggleSidebar);
  const homeStatus = useHomeStatus();
  const items = getNavItems({
    placement: "sidebar",
    isAuthenticated: Boolean(session),
    role: session?.user.role,
  });
  const groups = (["main", "footer"] as const).map((id) => ({
    id,
    items: items.filter((item) => item.group === id),
  }));
  const toggleLabel = sidebarCollapsed ? t("nav:sidebar.expand") : t("nav:sidebar.collapse");
  const ToggleIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="flex min-h-full min-w-0 flex-col md:flex-row">
      <aside
        data-app-nav="sidebar"
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-[100cqh] md:max-h-[100cqh] md:shrink-0 md:flex-col md:self-start md:overflow-x-hidden md:overflow-y-auto md:overscroll-contain md:border-e",
          sidebarCollapsed ? "w-16" : "w-60",
        )}
      >
        <nav
          aria-label={t("nav:sidebar.ariaLabel")}
          className="flex flex-1 flex-col gap-1 px-2 pt-3 pb-2"
        >
          {groups.map((group) => (
            <div
              key={group.id}
              className={cn(
                "flex flex-col gap-1",
                group.id === "footer" && "mt-auto border-t border-sidebar-border pt-2",
              )}
            >
              {group.items.map((item) => (
                <SidebarLink
                  key={item.id}
                  item={item}
                  lang={lang}
                  collapsed={sidebarCollapsed}
                  badge={navBadgeCount(item.id, homeStatus.data)}
                />
              ))}
            </div>
          ))}
        </nav>
        <div
          className={cn(
            "flex border-t border-sidebar-border p-2",
            sidebarCollapsed ? "justify-center" : "justify-end",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-pressed={sidebarCollapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
            className="text-muted-foreground"
            onClick={toggleSidebar}
          >
            <ToggleIcon aria-hidden="true" />
          </Button>
        </div>
      </aside>

      {/* The SkipLink target: focusable by script only, no ring of its own. */}
      <div
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col outline-none"
      >
        {children}
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  lang,
  collapsed,
  badge,
}: {
  item: AppNavItem;
  lang: string;
  collapsed: boolean;
  /** Count shown on this item (0 hides it). */
  badge: number;
}) {
  const { t } = useTranslation(["nav"]);
  const label = t(`nav:${item.labelKey}`);
  const name = badge > 0 ? `${label}, ${t("nav:badge.pendingProposals", { count: badge })}` : label;
  return (
    <Link
      to={toLangRoute(item.path)}
      params={{ lang }}
      activeOptions={{ exact: item.exact }}
      aria-label={name}
      title={item.hintKey ? t(`nav:${item.hintKey}`) : label}
      className={cn(
        buttonVariants({ variant: "ghost", size: collapsed ? "icon-touch" : "touch" }),
        "relative w-full not-data-[status=active]:text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed ? "justify-center" : "justify-start gap-3",
      )}
      activeProps={{ className: "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" }}
    >
      <item.icon aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? (
        <NavBadge count={badge} className="absolute -end-0.5 -top-0.5" />
      ) : (
        <>
          <span className="min-w-0 truncate">{label}</span>
          <NavBadge count={badge} className="ms-auto" />
        </>
      )}
    </Link>
  );
}
