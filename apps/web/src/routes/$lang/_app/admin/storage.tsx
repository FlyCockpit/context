import { Button } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight, Eraser, GitBranch, HardDrive, Lock, Trash } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { DeleteStorageDialog, type StorageDeleteTarget } from "@/components/admin/storage-overlays";
import { EmptyState } from "@/components/empty-state";
import { FillMeter } from "@/components/fill-meter";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import {
  CHECKOUT_STATUS_TONE,
  REPOSITORY_STATUS_TONE,
  STORAGE_LEVEL_TONE,
  type StorageCheckout,
  type StorageLevel,
  type StorageRepository,
  storageFraction,
  storageLevel,
} from "@/lib/admin";
import { describeResolvedFrom, formatBytes, shortSha } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/storage")({
  component: AdminStorage,
});

const PAGE_LIMIT = 25;

const METER_TONE = { ok: "default", near: "warning", over: "danger" } as const satisfies Record<
  StorageLevel,
  string
>;

/**
 * Storage across every repository (docs/product.md): the
 * meter against COCKPIT_CONTEXT_MAX_STORAGE_GB, the clones with their checkouts, delete
 * and "Prune now". No package notes, conversations or keys reach this page.
 */
function AdminStorage() {
  const { t } = useTranslation(["admin"]);
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<StorageDeleteTarget | null>(null);

  const list = useInfiniteQuery(
    orpc.adminStorage.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const repositories = list.data?.pages.flatMap((page) => page.items) ?? [];
  const totals = list.data?.pages[0];

  const prune = useEntityMutation(
    {
      ...orpc.adminStorage.prune.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: orpc.adminStorage.key() });
        },
      }),
      meta: { errorFallbackKey: "admin:storage.prune.failed" },
    },
    { invalidateKey: orpc.adminJobs.key(), successMessage: t("admin:storage.prune.queued") },
  );

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("admin:storage.title")}
        description={t("admin:storage.description")}
        actions={
          <Button
            size="touch"
            variant="outline"
            disabled={prune.isPending}
            onClick={() => prune.mutate({})}
          >
            <Eraser aria-hidden="true" className="size-4" />
            {prune.isPending ? t("admin:storage.prune.pending") : t("admin:storage.prune.action")}
          </Button>
        }
      />

      <UsageCard
        isPending={list.isPending}
        totalBytes={totals?.totalBytes}
        capBytes={totals?.capBytes}
      />

      {totals && totals.totalBytes > totals.capBytes && totals.snapshotBytes > 0 ? (
        <p
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          {t("admin:storage.snapshotsOverCap")}
        </p>
      ) : null}
      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle>{t("admin:storage.repositories.title")}</CardTitle>
          <CardDescription>{t("admin:storage.repositories.description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<RepositorySkeleton />}
            errorMessage={t("admin:storage.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                icon={HardDrive}
                title={t("admin:storage.repositories.empty")}
                description={t("admin:storage.repositories.emptyBody")}
              />
            }
          >
            {() => (
              <>
                <WideContent>
                  <table className="w-full min-w-[52rem] text-sm">
                    <thead className="border-y bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-4 py-2 text-start font-medium">
                          {t("admin:storage.columns.repository")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-start font-medium">
                          {t("admin:storage.columns.status")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-end font-medium">
                          {t("admin:storage.columns.size")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-end font-medium">
                          {t("admin:storage.columns.checkouts")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-start font-medium">
                          {t("admin:storage.columns.lastUsed")}
                        </th>
                        <th scope="col" className="px-4 py-2 text-end font-medium">
                          <span className="sr-only">{t("admin:storage.columns.actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {repositories.map((repository) => (
                        <RepositoryRows
                          key={repository.id}
                          repository={repository}
                          expanded={expanded.has(repository.id)}
                          onToggle={() => toggle(repository.id)}
                          onDeleteRepository={() =>
                            setDeleteTarget({ kind: "repository", repository })
                          }
                          onDeleteCheckout={(checkout) =>
                            setDeleteTarget({ kind: "checkout", repository, checkout })
                          }
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

      <DeleteStorageDialog
        target={deleteTarget}
        onOpenChange={(open) => (open ? null : setDeleteTarget(null))}
      />
    </PageShell>
  );
}

function UsageCard({
  isPending,
  totalBytes,
  capBytes,
}: {
  isPending: boolean;
  totalBytes: number | undefined;
  capBytes: number | undefined;
}) {
  const { t, i18n } = useTranslation(["admin"]);
  if (isPending || totalBytes === undefined || capBytes === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("admin:storage.usage.title")}</CardTitle>
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-2 w-full" />
        </CardContent>
      </Card>
    );
  }
  const level = storageLevel(totalBytes, capBytes);
  const fraction = storageFraction(totalBytes, capBytes);
  const used = formatBytes(totalBytes, i18n.language);
  const cap = formatBytes(capBytes, i18n.language);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(capBytes > 0 ? totalBytes / capBytes : 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("admin:storage.usage.title")}
          <StatusPill tone={STORAGE_LEVEL_TONE[level]}>
            {t(`admin:storage.usage.level.${level}`)}
          </StatusPill>
        </CardTitle>
        <CardDescription>{t("admin:storage.usage.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xl font-semibold tabular-nums">
          {t("admin:storage.usage.amount", { used, cap })}
        </p>
        <FillMeter
          fraction={fraction}
          label={percent}
          ariaLabel={t("admin:storage.usage.meterLabel", { used, cap })}
          tone={METER_TONE[level]}
        />
      </CardContent>
    </Card>
  );
}

function RepositoryRows({
  repository,
  expanded,
  onToggle,
  onDeleteRepository,
  onDeleteCheckout,
}: {
  repository: StorageRepository;
  expanded: boolean;
  onToggle: () => void;
  onDeleteRepository: () => void;
  onDeleteCheckout: (checkout: StorageCheckout) => void;
}) {
  const { t, i18n } = useTranslation(["admin"]);
  const panelId = `repository-${repository.id}-checkouts`;
  return (
    <Fragment>
      <tr className="align-middle">
        <td className="max-w-md px-2 py-2">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-touch"
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              aria-label={
                expanded
                  ? t("admin:storage.repositories.collapse", { url: repository.remoteUrl })
                  : t("admin:storage.repositories.expand", { url: repository.remoteUrl })
              }
              onClick={onToggle}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-4 transition-transform motion-reduce:transition-none",
                  expanded && "rotate-90",
                )}
              />
            </Button>
            <div className="min-w-0">
              <p className="truncate font-mono text-xs" title={repository.remoteUrl}>
                {repository.remoteUrl}
              </p>
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {repository.visibility === "private" ? (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Lock aria-hidden="true" className="size-3 shrink-0" />
                    <span className="truncate">
                      {repository.ownerEmail
                        ? t("admin:storage.repositories.privateOwner", {
                            email: repository.ownerEmail,
                          })
                        : t("admin:storage.repositories.private")}
                    </span>
                  </span>
                ) : (
                  <span>{t("admin:storage.repositories.public")}</span>
                )}
                <span aria-hidden="true">·</span>
                <span>
                  {t("admin:storage.repositories.packages", { count: repository.packageCount })}
                </span>
              </p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2">
          <StatusPill tone={REPOSITORY_STATUS_TONE[repository.status]}>
            {t(`admin:storage.repositoryStatus.${repository.status}`)}
          </StatusPill>
          {repository.isSnapshot ? (
            <StatusPill tone="muted">{t("admin:storage.snapshot")}</StatusPill>
          ) : null}
        </td>
        <td className="px-3 py-2 text-end whitespace-nowrap tabular-nums">
          {formatBytes(repository.diskBytes, i18n.language)}
        </td>
        <td className="px-3 py-2 text-end tabular-nums">{repository.checkoutCount}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          <TimeAgo value={repository.lastUsedAt} />
        </td>
        <td className="px-4 py-2 text-end">
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t("admin:storage.delete.repositoryAction", { url: repository.remoteUrl })}
            onClick={onDeleteRepository}
          >
            <Trash aria-hidden="true" className="size-4" />
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr id={panelId} className="bg-muted/20">
          <td colSpan={6} className="px-4 py-3">
            <CheckoutList repository={repository} onDelete={onDeleteCheckout} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function CheckoutList({
  repository,
  onDelete,
}: {
  repository: StorageRepository;
  onDelete: (checkout: StorageCheckout) => void;
}) {
  const { t, i18n } = useTranslation(["admin", "dashboard"]);
  if (repository.checkouts.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 ps-12 text-sm text-muted-foreground">
        <GitBranch aria-hidden="true" className="size-4" />
        {t("admin:storage.checkouts.empty")}
      </p>
    );
  }
  return (
    <div className="space-y-2 ps-12">
      <table className="w-full text-sm">
        <caption className="sr-only">
          {t("admin:storage.checkouts.caption", { url: repository.remoteUrl })}
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pe-3 text-start font-medium">
              {t("admin:storage.checkouts.ref")}
            </th>
            <th scope="col" className="px-3 py-1 text-start font-medium">
              {t("admin:storage.checkouts.commit")}
            </th>
            <th scope="col" className="px-3 py-1 text-end font-medium">
              {t("admin:storage.columns.size")}
            </th>
            <th scope="col" className="px-3 py-1 text-start font-medium">
              {t("admin:storage.columns.lastUsed")}
            </th>
            <th scope="col" className="ps-3 py-1 text-end font-medium">
              <span className="sr-only">{t("admin:storage.columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {repository.checkouts.map((checkout) => {
            const target = describeResolvedFrom(checkout.resolvedFrom, checkout.sha);
            return (
              <tr key={checkout.id} className="align-middle">
                <td className="max-w-56 py-1 pe-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-mono">{target.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`dashboard:checkouts.kind.${target.kind}`)}
                      </span>
                    </span>
                    {checkout.status === "ready" ? null : (
                      <StatusPill tone={CHECKOUT_STATUS_TONE[checkout.status]}>
                        {t(`dashboard:checkouts.status.${checkout.status}`)}
                      </StatusPill>
                    )}
                  </span>
                </td>
                <td className="px-3 py-1">
                  <code className="font-mono text-xs" title={checkout.sha}>
                    {shortSha(checkout.sha)}
                  </code>
                </td>
                <td className="px-3 py-1 text-end whitespace-nowrap tabular-nums">
                  {formatBytes(checkout.diskBytes, i18n.language)}
                </td>
                <td className="px-3 py-1 whitespace-nowrap">
                  <TimeAgo value={checkout.lastUsedAt} />
                  {checkout.leased ? (
                    <span className="ms-2">
                      <StatusPill tone="busy">{t("dashboard:checkouts.inUse")}</StatusPill>
                    </span>
                  ) : null}
                </td>
                <td className="py-1 ps-3 text-end">
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("admin:storage.delete.checkoutAction", {
                      version: target.label,
                    })}
                    onClick={() => onDelete(checkout)}
                  >
                    <Trash aria-hidden="true" className="size-4" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {repository.checkoutCount > repository.checkouts.length ? (
        <p className="text-xs text-muted-foreground">
          {t("admin:storage.checkouts.truncated", {
            shown: repository.checkouts.length,
            count: repository.checkoutCount,
          })}
        </p>
      ) : null}
    </div>
  );
}

function RepositorySkeleton() {
  return (
    <div className="divide-y border-t" aria-hidden="true">
      {["a", "b", "c"].map((row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="size-8" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
