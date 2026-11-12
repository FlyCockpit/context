import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileWarning, ListChecks, RotateCcw } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import {
  type AdminJob,
  JOB_FILTERS,
  JOB_STATUS_TONE,
  jobStatusInput,
  jobTimestamp,
} from "@/lib/admin";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/jobs")({
  component: AdminJobs,
});

const PAGE_LIMIT = 50;

/**
 * The background job table (docs/product.md): recent jobs,
 * filterable by status, with retry for a failed one. Payloads never reach
 * this page; the error text is operator detail shown in a dialog.
 */
function AdminJobs() {
  const { t } = useTranslation(["admin"]);
  const [filter, setFilter] = useQueryState(
    "status",
    parseAsStringLiteral(JOB_FILTERS).withDefault("all"),
  );
  const [viewing, setViewing] = useState<AdminJob | null>(null);

  const list = useInfiniteQuery(
    orpc.adminJobs.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE_LIMIT,
        cursor,
        status: jobStatusInput(filter),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const jobs = list.data?.pages.flatMap((page) => page.items) ?? [];

  const retry = useEntityMutation(
    {
      ...orpc.adminJobs.retry.mutationOptions({
        onSuccess: () => setViewing(null),
      }),
      meta: { errorFallbackKey: "admin:jobs.retryFailed" },
    },
    { invalidateKey: orpc.adminJobs.key(), successMessage: t("admin:jobs.retried") },
  );
  const retryingId = retry.isPending ? retry.variables?.id : undefined;

  return (
    <PageShell width="wide">
      <PageHeader title={t("admin:jobs.title")} description={t("admin:jobs.description")} />

      <SegmentedControl
        value={filter}
        onChange={(next) => void setFilter(next === "all" ? null : next)}
        ariaLabel={t("admin:jobs.filterLabel")}
        items={JOB_FILTERS.map((value) => ({ value, label: t(`admin:jobs.filter.${value}`) }))}
      />

      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<JobsSkeleton />}
            errorMessage={t("admin:jobs.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                icon={ListChecks}
                title={
                  filter === "all" ? t("admin:jobs.empty") : t(`admin:jobs.emptyFiltered.${filter}`)
                }
                description={t("admin:jobs.emptyBody")}
              />
            }
          >
            {() => (
              <>
                <WideContent>
                  <table className="w-full min-w-[48rem] text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-4 py-2 text-start font-medium">
                          {t("admin:jobs.columns.type")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-start font-medium">
                          {t("admin:jobs.columns.status")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-end font-medium">
                          {t("admin:jobs.columns.attempts")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-start font-medium">
                          {t("admin:jobs.columns.created")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-start font-medium">
                          {t("admin:jobs.columns.when")}
                        </th>
                        <th scope="col" className="px-4 py-2 text-end font-medium">
                          <span className="sr-only">{t("admin:jobs.columns.actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {jobs.map((job) => (
                        <JobRow
                          key={job.id}
                          job={job}
                          retrying={retryingId === job.id}
                          retryDisabled={retry.isPending}
                          onView={() => setViewing(job)}
                          onRetry={() => retry.mutate({ id: job.id })}
                        />
                      ))}
                    </tbody>
                  </table>
                </WideContent>
                <LoadMore
                  hasNextPage={list.hasNextPage}
                  isFetchingNextPage={list.isFetchingNextPage}
                  onLoadMore={() => void list.fetchNextPage()}
                />
              </>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <JobErrorDialog
        job={viewing}
        retrying={viewing !== null && retryingId === viewing.id}
        onOpenChange={(open) => (open ? null : setViewing(null))}
        onRetry={(job) => retry.mutate({ id: job.id })}
      />
    </PageShell>
  );
}

function JobRow({
  job,
  retrying,
  retryDisabled,
  onView,
  onRetry,
}: {
  job: AdminJob;
  retrying: boolean;
  retryDisabled: boolean;
  onView: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["admin"]);
  const when = jobTimestamp(job);
  return (
    <tr className="align-middle">
      <td className="max-w-64 px-4 py-2">
        <code className="block truncate font-mono text-xs" title={job.type}>
          {job.type}
        </code>
      </td>
      <td className="px-3 py-2">
        <StatusPill tone={JOB_STATUS_TONE[job.status]}>
          {t(`admin:jobs.status.${job.status}`)}
        </StatusPill>
      </td>
      <td className="px-3 py-2 text-end tabular-nums">
        {t("admin:jobs.attempts", { attempts: job.attempts, max: job.maxAttempts })}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <TimeAgo value={job.createdAt} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="text-muted-foreground">{t(`admin:jobs.when.${when.kind}`)} </span>
        <TimeAgo value={when.at} />
      </td>
      <td className="px-4 py-2">
        <div className="flex justify-end gap-1">
          {job.lastError ? (
            <Button
              variant="ghost"
              size="touch"
              aria-label={t("admin:jobs.viewErrorFor", { type: job.type })}
              onClick={onView}
            >
              <FileWarning aria-hidden="true" className="size-4" />
              {t("admin:jobs.viewError")}
            </Button>
          ) : null}
          {job.status === "failed" ? (
            <Button
              variant="outline"
              size="touch"
              disabled={retryDisabled}
              aria-label={t("admin:jobs.retryFor", { type: job.type })}
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              {retrying ? t("admin:jobs.retrying") : t("admin:jobs.retry")}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function JobErrorDialog({
  job,
  retrying,
  onOpenChange,
  onRetry,
}: {
  job: AdminJob | null;
  retrying: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: (job: AdminJob) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  return (
    <Dialog open={job !== null} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common:actions.close")} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("admin:jobs.errorTitle")}</DialogTitle>
          <DialogDescription>
            {job
              ? t("admin:jobs.errorDescription", {
                  type: job.type,
                  attempts: job.attempts,
                  max: job.maxAttempts,
                })
              : null}
          </DialogDescription>
        </DialogHeader>
        {job?.lastError ? (
          <CodeSnippet
            code={job.lastError}
            copyLabel={t("admin:jobs.copyError")}
            preClassName="max-h-80"
          />
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="touch" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          {job?.status === "failed" ? (
            <Button size="touch" disabled={retrying} onClick={() => onRetry(job)}>
              <RotateCcw aria-hidden="true" className="size-4" />
              {retrying ? t("admin:jobs.retrying") : t("admin:jobs.retry")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobsSkeleton() {
  return (
    <div className="divide-y" aria-hidden="true">
      {["a", "b", "c", "d", "e"].map((row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-28" />
        </div>
      ))}
    </div>
  );
}
