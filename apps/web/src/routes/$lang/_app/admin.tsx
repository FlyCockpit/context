import { SelectorRow } from "@cockpit-context/ui/components/selector-row";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, Outlet } from "@tanstack/react-router";
import { Database, HardDrive, LayoutDashboard, ListChecks, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TwoFactorNudge } from "@/components/admin/two-factor-nudge";
import { AppFrame } from "@/components/app-frame";
import { InlineRetry } from "@/components/inline-retry";
import { TwoFactorSetupRequired } from "@/components/two-factor-enrollment";
import { decideAdminRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { orpc } from "@/utils/orpc";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

export const Route = createFileRoute("/$lang/_app/admin")({
  beforeLoad: async () => {
    const decision = decideAdminRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    // 404-hide the entire admin tree from confirmed non-admins. Throwing
    // notFound() (instead of redirect) means an unauthorized visitor can't
    // tell whether /admin exists at all — same response as a route that
    // doesn't exist. Resolution failures are route errors, not 404s.
    if (decision.kind === "not-found") throw notFound();
    return { session: decision.session };
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { lang } = Route.useParams();
  const { session } = Route.useRouteContext();
  const { t } = useTranslation("dashboard");
  const settings = useQuery(orpc.settings.getAll.queryOptions());
  if (settings.isPending)
    return (
      <AppFrame lang={lang}>
        <Skeleton className="m-4 h-40" />
      </AppFrame>
    );
  if (settings.isError)
    return (
      <AppFrame lang={lang}>
        <InlineRetry message={t("appSettingsLoadFailed")} onRetry={() => settings.refetch()} />
      </AppFrame>
    );
  if (twoFactorEnrollmentState(settings.data, session.user).status === "blocked")
    return <TwoFactorSetupRequired />;
  return (
    <AppFrame lang={lang}>
      <div className="min-h-full">
        <AdminNav />
        <TwoFactorNudge />
        <Outlet />
      </div>
    </AppFrame>
  );
}

function AdminNav() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("admin");
  const seedInfo = useQuery({
    ...orpc.seed.info.queryOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const NAV_ITEMS = [
    {
      to: "/$lang/admin" as const,
      label: t("nav.overview"),
      icon: LayoutDashboard,
      exact: true,
    },
    {
      to: "/$lang/admin/users" as const,
      label: t("nav.users"),
      icon: Users,
      exact: false,
    },
    {
      to: "/$lang/admin/storage" as const,
      label: t("nav.storage"),
      icon: HardDrive,
      exact: false,
    },
    {
      to: "/$lang/admin/jobs" as const,
      label: t("nav.jobs"),
      icon: ListChecks,
      exact: false,
    },
    {
      to: "/$lang/admin/settings" as const,
      label: t("nav.settings"),
      icon: Settings,
      exact: false,
    },
    {
      to: "/$lang/admin/seed" as const,
      label: t("nav.seed"),
      icon: Database,
      exact: false,
    },
  ];
  return (
    <nav
      aria-label={t("nav.ariaLabel")}
      className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur"
    >
      <div className="container mx-auto min-w-0 max-w-7xl">
        <SelectorRow className="-mb-px" innerClassName="gap-1 px-4 py-2">
          {NAV_ITEMS.filter(
            (item) => item.to !== "/$lang/admin/seed" || seedInfo.data?.isProduction === false,
          ).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ lang }}
              activeOptions={{ exact: item.exact }}
              className={cn(
                "inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium not-data-[status=active]:text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              )}
              activeProps={{
                className: "bg-muted text-foreground",
              }}
            >
              <item.icon aria-hidden="true" className="size-4" />
              <span>{item.label}</span>
            </Link>
          ))}
        </SelectorRow>
        {seedInfo.isError ? (
          <InlineRetry
            className="mx-4 py-2"
            message={t("seedPage.loadInfoFailed")}
            onRetry={() => seedInfo.refetch()}
          />
        ) : null}
      </div>
    </nav>
  );
}
