import { buttonVariants } from "@cockpit-context/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@cockpit-context/ui/components/card";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, HardDrive, ListChecks, Settings, Users } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { formatBytes } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

type Figure = { value: string; caption: string; detail?: string };

type OverviewCard = {
  to: "/$lang/admin/users" | "/$lang/admin/storage" | "/$lang/admin/jobs" | "/$lang/admin/settings";
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  figure: Figure | null;
  attention?: boolean;
};

/** How often the open overview refreshes its figures. */
const OVERVIEW_REFRESH_MS = 60_000;

/**
 * The admin overview's section cards, each with one live figure
 * (`adminOverview.stats`): active users, storage used, failed jobs and
 * whether sign-up is open. A failed job count above zero turns its card to the
 * warning tone and its action to "Review". While the figures load each card
 * shows a skeleton the size of its number; if they fail the cards keep their
 * links and one inline retry sits above them.
 */
export function AdminOverviewCards({ lang }: { lang: string }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  // Live figures: refetched on every visit (other admin pages change them
  // without knowing about this query) and every minute while it is open.
  const stats = useQuery({
    ...orpc.adminOverview.stats.queryOptions(),
    staleTime: 0,
    refetchInterval: OVERVIEW_REFRESH_MS,
  });
  const data = stats.data;
  const number = new Intl.NumberFormat(i18n.language);

  const cards: OverviewCard[] = [
    {
      to: "/$lang/admin/users",
      label: t("admin:nav.users"),
      hint: t("admin:overview.hint.users"),
      icon: Users,
      figure: data
        ? {
            value: number.format(data.users.active),
            caption: t("admin:overview.stats.activeUsers", { count: data.users.active }),
            detail:
              data.users.archived > 0
                ? t("admin:overview.stats.archivedUsers", {
                    count: data.users.archived,
                    formatted: number.format(data.users.archived),
                  })
                : undefined,
          }
        : null,
    },
    {
      to: "/$lang/admin/storage",
      label: t("admin:nav.storage"),
      hint: t("admin:overview.hint.storage"),
      icon: HardDrive,
      figure: data
        ? {
            value: formatBytes(data.storage.totalBytes, i18n.language),
            caption: t("admin:overview.stats.storageOfCap", {
              cap: formatBytes(data.storage.capBytes, i18n.language),
            }),
          }
        : null,
    },
    {
      to: "/$lang/admin/jobs",
      label: t("admin:nav.jobs"),
      hint: t("admin:overview.hint.jobs"),
      icon: ListChecks,
      figure: data
        ? {
            value: number.format(data.jobs.failed),
            caption: t("admin:overview.stats.failedJobs", { count: data.jobs.failed }),
          }
        : null,
      attention: (data?.jobs.failed ?? 0) > 0,
    },
    {
      to: "/$lang/admin/settings",
      label: t("admin:nav.settings"),
      hint: t("admin:overview.hint.settings"),
      icon: Settings,
      figure: data
        ? {
            value: data.settings.signupOpen
              ? t("admin:overview.stats.signupOpen")
              : t("admin:overview.stats.signupClosed"),
            caption: t("admin:overview.stats.signup"),
          }
        : null,
    },
  ];

  return (
    <>
      {stats.isError && (
        <InlineRetry
          message={t("admin:overview.stats.loadFailed")}
          onRetry={() => void stats.refetch()}
          className="flex-row flex-wrap justify-start py-0 text-left"
        />
      )}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Card
            key={card.to}
            className={cn(card.attention && "bg-state-warning-bg ring-state-warning/50")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <card.icon aria-hidden="true" className="size-4" />
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <FigureBlock
                figure={card.figure}
                pending={stats.isPending}
                attention={card.attention}
              />
              <p className="text-sm text-muted-foreground">{card.hint}</p>
              <Link
                to={card.to}
                params={{ lang }}
                className={cn(
                  buttonVariants({
                    variant: card.attention ? "default" : "secondary",
                    size: "touch",
                  }),
                  "mt-auto self-start",
                )}
              >
                {card.attention ? t("admin:overview.review") : t("common:actions.manage")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </>
  );
}

function FigureBlock({
  figure,
  pending,
  attention,
}: {
  figure: Figure | null;
  pending: boolean;
  attention?: boolean;
}) {
  if (pending) {
    return (
      <div className="space-y-1" aria-hidden="true">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-5 w-32" />
      </div>
    );
  }
  // Errored: no figure, but keep the card's height steady.
  if (!figure) {
    return (
      <div className="space-y-1">
        <p aria-hidden="true" className="text-2xl font-semibold text-muted-foreground">
          –
        </p>
        <div className="h-5" />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-2xl font-semibold tabular-nums break-words">
        {attention && (
          <AlertTriangle aria-hidden="true" className="size-5 shrink-0 text-state-warning" />
        )}
        {figure.value}
      </p>
      <p className="text-sm text-muted-foreground">
        {figure.caption}
        {figure.detail && <span> · {figure.detail}</span>}
      </p>
    </div>
  );
}
