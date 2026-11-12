import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import NotFoundState from "@/components/not-found-state";

import { PageHeader, PageShell, type SectionTab, SectionTabs } from "@/components/page-shell";
import { accessNavItems, toLangRoute } from "@/lib/nav-items";

export const Route = createFileRoute("/$lang/_app/_auth/access")({
  component: AccessLayout,
  // The layout already renders the page h1, so the not-found message nests.
  notFoundComponent: () => <NotFoundState nested />,
});

/** Access: MCP tokens, OAuth connections, SSH keys and known hosts, one tab each. */
function AccessLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  // Render tabs in the shared navigation order.
  const tabs: SectionTab[] = accessNavItems.map((item) => ({
    key: item.path,
    label: t(item.labelKey),
    render: (className, activeClassName, children) => (
      <Link
        to={toLangRoute(item.path)}
        params={{ lang }}
        activeOptions={{ exact: item.exact }}
        className={className}
        activeProps={{ className: activeClassName }}
      >
        <item.icon aria-hidden="true" className="size-4" />
        {children}
      </Link>
    ),
  }));

  return (
    <PageShell>
      <PageHeader
        title={t("dashboard:pages.access.title")}
        description={t("dashboard:pages.access.description")}
      />
      <SectionTabs tabs={tabs} ariaLabel={t("dashboard:access.tabsAriaLabel")} />
      <Outlet />
    </PageShell>
  );
}
