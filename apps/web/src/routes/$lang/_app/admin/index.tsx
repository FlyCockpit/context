import { buttonVariants } from "@cockpit-context/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@cockpit-context/ui/components/card";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HardDrive, ListChecks, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BackupStatusCard } from "@/components/admin/backup-status-card";
import { PageHeader, PageShell } from "@/components/page-shell";

export const Route = createFileRoute("/$lang/_app/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin", "common"]);

  return (
    <PageShell width="wide">
      <PageHeader title={t("admin:overview.title")} description={t("admin:overview.description")} />
      <BackupStatusCard />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            {
              to: "/$lang/admin/users",
              label: t("admin:nav.users"),
              hint: t("admin:overview.hint.users"),
              icon: Users,
            },
            {
              to: "/$lang/admin/storage",
              label: t("admin:nav.storage"),
              hint: t("admin:overview.hint.storage"),
              icon: HardDrive,
            },
            {
              to: "/$lang/admin/jobs",
              label: t("admin:nav.jobs"),
              hint: t("admin:overview.hint.jobs"),
              icon: ListChecks,
            },
            {
              to: "/$lang/admin/settings",
              label: t("admin:nav.settings"),
              hint: t("admin:overview.hint.settings"),
              icon: Settings,
            },
          ] as const
        ).map((item) => (
          <Card key={item.to}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <item.icon aria-hidden="true" className="size-4" />
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{item.hint}</p>
              <Link
                to={item.to}
                params={{ lang }}
                className={buttonVariants({ variant: "secondary", size: "touch" })}
              >
                {t("common:actions.manage")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </PageShell>
  );
}
