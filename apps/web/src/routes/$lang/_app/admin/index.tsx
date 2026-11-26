import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { BackupStatusCard } from "@/components/admin/backup-status-card";
import { AdminOverviewCards } from "@/components/admin/overview-cards";
import { PageHeader, PageShell } from "@/components/page-shell";

export const Route = createFileRoute("/$lang/_app/admin/")({
  staticData: { pendingShape: "dashboard", pendingWidth: "wide" },
  component: AdminOverview,
});

function AdminOverview() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin"]);

  return (
    <PageShell width="wide">
      <PageHeader title={t("admin:overview.title")} description={t("admin:overview.description")} />
      <BackupStatusCard />
      <AdminOverviewCards lang={lang} />
    </PageShell>
  );
}
