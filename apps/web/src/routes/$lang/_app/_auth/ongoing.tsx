import { isAdminRole } from "@cockpit-context/auth/roles";
import { buttonVariants } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConversationRowMenu } from "@/components/conversations/conversation-pin";
import {
  ConversationRow,
  ConversationRowsSkeleton,
} from "@/components/conversations/conversation-row";
import { PinnedSection } from "@/components/conversations/pinned-section";
import { GettingStarted } from "@/components/getting-started";
import { InlineRetry } from "@/components/inline-retry";
import { PendingProposalsBanner } from "@/components/packages/pending-proposals-banner";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { useHomeStatus } from "@/hooks/use-home-status";
import { useNow } from "@/hooks/use-now";
import { useRunActivity } from "@/hooks/use-run-activity";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/ongoing")({
  staticData: { pendingShape: "list" },
  component: OngoingPage,
});

const LINK_BUTTON = cn(buttonVariants({ variant: "outline", size: "touch" }), "gap-2");

function OngoingPage() {
  const { lang } = Route.useParams();
  const { session } = Route.useRouteContext();
  const { t } = useTranslation(["dashboard"]);
  const status = useHomeStatus();

  return (
    <PageShell>
      <PageHeader
        title={t("dashboard:pages.ongoing.title")}
        description={t("dashboard:pages.ongoing.description")}
      />
      {status.isPending ? (
        <OngoingSkeleton />
      ) : status.isError ? (
        <InlineRetry
          className="py-12"
          message={t("dashboard:ongoing.loadFailed")}
          onRetry={() => status.refetch()}
        />
      ) : (
        <>
          {status.data.modelConfigured === false ? (
            <Card className="border-yellow-500/50" role="alert">
              <CardHeader>
                <CardTitle>{t("dashboard:ongoing.modelMissing.title")}</CardTitle>
                <CardDescription>
                  {t(
                    isAdminRole(session.user.role)
                      ? "dashboard:ongoing.modelMissing.admin"
                      : "dashboard:ongoing.modelMissing.user",
                  )}
                </CardDescription>
              </CardHeader>
              {isAdminRole(session.user.role) ? (
                <CardContent>
                  <Link to="/$lang/admin/settings" params={{ lang }} className={LINK_BUTTON}>
                    {t("dashboard:ongoing.modelMissing.action")}
                  </Link>
                </CardContent>
              ) : null}
            </Card>
          ) : null}
          {/* An agent waiting on an approval is the most urgent thing here. */}
          <PendingProposalsBanner lang={lang} />
          {/* Renders nothing once every step is done or the user hid it. */}
          <GettingStarted lang={lang} status={status.data} scope={session.user.id} />
          <LiveSection lang={lang} />
        </>
      )}
    </PageShell>
  );
}

function OngoingSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <Skeleton className="h-80 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}

// ── Live investigations ──

/** Live rows shown here; the history page pages through the rest. */
const LIVE_LIMIT = 20;
const RECENT_LIMIT = 5;

function LiveSection({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  useRunActivity();
  const ongoing = useQuery(
    orpc.conversations.list.queryOptions({ input: { segment: "ongoing", limit: LIVE_LIMIT } }),
  );
  const recent = useQuery(
    orpc.conversations.list.queryOptions({ input: { segment: "finished", limit: RECENT_LIMIT } }),
  );
  // The ongoing segment tops a short page up with finished rows: keep the live ones.
  const live = ongoing.data?.items.filter((item) => item.ongoing) ?? [];
  const liveIds = new Set(live.map((item) => item.id));
  const now = useNow(1_000, live.length > 0);

  return (
    <>
      {/* Hidden until something is pinned. */}
      <PinnedSection lang={lang} now={now} />
      <section aria-labelledby="ongoing-live-title" className="space-y-3">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
          <h2 id="ongoing-live-title" className="flex items-center gap-2 text-base font-semibold">
            {t("dashboard:ongoing.live.title")}
            {live.length > 0 ? <StatusPill tone="busy">{live.length}</StatusPill> : null}
          </h2>
        </div>
        <Card className="py-0">
          <CardContent className="p-0" aria-live="polite">
            <QueryBoundary
              query={ongoing}
              skeleton={<ConversationRowsSkeleton rows={2} />}
              errorMessage={t("dashboard:ongoing.live.loadFailed")}
              errorClassName="py-8"
              isEmpty={(data) => !data.items.some((item) => item.ongoing)}
              empty={<IdleState />}
            >
              {() => (
                <ul className="divide-y">
                  {live.map((item) => (
                    <li key={item.id}>
                      <ConversationRow
                        item={item}
                        lang={lang}
                        now={now}
                        actions={<ConversationRowMenu id={item.id} title={item.title} />}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="ongoing-recent-title" className="space-y-3">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
          <h2 id="ongoing-recent-title" className="text-base font-semibold">
            {t("dashboard:ongoing.recent.title")}
          </h2>
          <Link
            to="/$lang/conversations"
            params={{ lang }}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md text-sm font-medium text-primary-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("dashboard:ongoing.live.history")}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <Card className="py-0">
          <CardContent className="p-0">
            <QueryBoundary
              query={recent}
              skeleton={<ConversationRowsSkeleton rows={3} />}
              errorMessage={t("dashboard:ongoing.recent.loadFailed")}
              errorClassName="py-8"
              isEmpty={(data) => data.items.every((item) => liveIds.has(item.id))}
              empty={
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("dashboard:ongoing.recent.empty")}
                </p>
              }
            >
              {(data) => (
                <ul className="divide-y">
                  {data.items
                    .filter((item) => !liveIds.has(item.id))
                    .map((item) => (
                      <li key={item.id}>
                        <ConversationRow
                          item={item}
                          lang={lang}
                          now={now}
                          actions={<ConversationRowMenu id={item.id} title={item.title} />}
                        />
                      </li>
                    ))}
                </ul>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function IdleState() {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="flex min-w-0 items-start gap-4 px-4 py-5">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"
      >
        <Activity className="size-5" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{t("dashboard:ongoing.live.idleTitle")}</p>
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          {t("dashboard:ongoing.live.idleBody")}
        </p>
      </div>
    </div>
  );
}
