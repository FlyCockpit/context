import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import NotFoundState from "@/components/not-found-state";

import { PageHeader, PageShell, type SectionTab, SectionTabs } from "@/components/page-shell";
import { settingsNavItems, toLangRoute } from "@/lib/nav-items";

export const Route = createFileRoute("/$lang/_app/_auth/settings")({
  component: SettingsLayout,
  // The layout already renders the page h1, so the not-found message nests.
  notFoundComponent: () => <NotFoundState nested />,
});

/**
 * Settings: Profile and Security. Same shell as Access (`PageHeader` and
 * `SectionTabs`), so every signed-in section shares one heading, width and tab
 * row.
 */
function SettingsLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("settings");
  // Render tabs in the shared navigation order.
  const tabs: SectionTab[] = settingsNavItems.map((item) => ({
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
      <PageHeader title={t("title")} description={t("description")} />
      <SectionTabs tabs={tabs} ariaLabel={t("tabsAriaLabel")} />
      <Outlet />
    </PageShell>
  );
}
