import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { Input } from "@cockpit-context/ui/components/input";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useDebounce } from "@cockpit-context/ui/hooks/use-async-search";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Inbox,
  KeyRound,
  MoreVertical,
  Package,
  Pencil,
  Plus,
  Trash,
} from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { NavBadge } from "@/components/nav-badge";
import { EcosystemIcon } from "@/components/packages/ecosystem-badge";
import {
  CreatePackageDialog,
  DeletePackageDialog,
  EditPackageSheet,
} from "@/components/packages/package-overlays";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { useHomeStatus } from "@/hooks/use-home-status";
import { describeResolvedFrom, ECOSYSTEMS, type PackageListItem } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/packages/")({
  component: PackagesPage,
});

const PAGE_LIMIT = 25;
const FILTERS = ["all", ...ECOSYSTEMS] as const;
/** How many checked-out versions a row names before "+N more". */
const VERSION_CHIPS = 3;

function PackagesPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const navigate = useNavigate();
  const [search, setSearch] = useQueryState("q", parseAsString.withDefault(""));
  const [ecosystem, setEcosystem] = useQueryState(
    "ecosystem",
    parseAsStringLiteral(FILTERS).withDefault("all"),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    identifier: string;
    isSnapshot?: boolean;
  } | null>(null);
  const debouncedSearch = useDebounce(search.trim(), 300);
  const filtered = debouncedSearch !== "" || ecosystem !== "all";

  const list = useInfiniteQuery(
    orpc.packages.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE_LIMIT,
        cursor,
        search: debouncedSearch || undefined,
        ecosystem: ecosystem === "all" ? undefined : ecosystem,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const packages = list.data?.pages.flatMap((page) => page.items) ?? [];

  const clearFilters = () => {
    void setSearch(null);
    void setEcosystem(null);
  };

  return (
    <PageShell>
      <PageHeader
        title={t("dashboard:pages.packages.title")}
        description={t("dashboard:pages.packages.description")}
        actions={
          <div className="flex flex-wrap gap-2">
            <ProposalsLink lang={lang} />
            <Button size="touch" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" className="size-4" />
              {t("dashboard:packages.add")}
            </Button>
          </div>
        }
      />

      <PendingBanner lang={lang} />

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          ariaLabel={t("dashboard:packages.filters.ecosystem")}
          value={ecosystem}
          onChange={(next) => void setEcosystem(next === "all" ? null : next)}
          items={FILTERS.map((value) => ({
            value,
            label:
              value === "all"
                ? t("dashboard:packages.filters.all")
                : t(`dashboard:packages.ecosystems.${value}`),
          }))}
        />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          aria-label={t("dashboard:packages.filters.search")}
          placeholder={t("dashboard:packages.filters.searchPlaceholder")}
          value={search}
          onChange={(event) => void setSearch(event.target.value || null)}
          className="min-h-[44px] sm:max-w-xs"
        />
      </div>

      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<PackageRowsSkeleton />}
            errorMessage={t("dashboard:packages.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              filtered ? (
                <EmptyState
                  title={t("dashboard:packages.empty.noMatch")}
                  description={t("dashboard:packages.empty.noMatchBody")}
                  action={
                    <Button variant="outline" size="touch" onClick={clearFilters}>
                      {t("dashboard:packages.filters.clear")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Package}
                  title={t("dashboard:packages.empty.title")}
                  description={t("dashboard:packages.empty.body")}
                  action={
                    <Button size="touch" onClick={() => setCreateOpen(true)}>
                      <Plus aria-hidden="true" className="size-4" />
                      {t("dashboard:packages.add")}
                    </Button>
                  }
                />
              )
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {packages.map((pkg) => (
                    <PackageRow
                      key={pkg.id}
                      pkg={pkg}
                      lang={lang}
                      onEdit={() => setEditId(pkg.id)}
                      onDelete={() =>
                        setDeleteTarget({
                          id: pkg.id,
                          identifier: pkg.identifier,
                          isSnapshot: pkg.isSnapshot,
                        })
                      }
                    />
                  ))}
                </ul>
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

      <CreatePackageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        lang={lang}
        onCreated={(packageId) => {
          setCreateOpen(false);
          void navigate({ to: "/$lang/packages/$packageId", params: { lang, packageId } });
        }}
      />
      <EditPackageSheet
        packageId={editId}
        onOpenChange={(open) => (open ? null : setEditId(null))}
        lang={lang}
      />
      <DeletePackageDialog
        pkg={deleteTarget}
        onOpenChange={(open) => (open ? null : setDeleteTarget(null))}
      />
    </PageShell>
  );
}

function ProposalsLink({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard", "nav"]);
  const pending = useHomeStatus().data?.pendingProposals ?? 0;
  return (
    <Link
      to="/$lang/packages/proposals"
      params={{ lang }}
      aria-label={
        pending > 0
          ? `${t("dashboard:proposals.title")}, ${t("nav:badge.pendingProposals", { count: pending })}`
          : undefined
      }
      className={cn(buttonVariants({ variant: "outline", size: "touch" }), "gap-2")}
    >
      <Inbox aria-hidden="true" className="size-4" />
      {t("dashboard:proposals.title")}
      <NavBadge count={pending} />
    </Link>
  );
}

/** The pending-proposals banner: agents asked for packages and are waiting on you. */
function PendingBanner({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const pending = useHomeStatus().data?.pendingProposals ?? 0;
  if (pending === 0) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Inbox
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            {t("dashboard:packages.pendingBanner.title", { count: pending })}
          </p>
          <p className="text-sm text-pretty text-muted-foreground">
            {t("dashboard:packages.pendingBanner.body")}
          </p>
        </div>
      </div>
      <Link
        to="/$lang/packages/proposals"
        params={{ lang }}
        className={cn(buttonVariants({ variant: "outline", size: "touch" }), "shrink-0 gap-2")}
      >
        {t("dashboard:packages.pendingBanner.action")}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </div>
  );
}

function PackageRow({
  pkg,
  lang,
  onEdit,
  onDelete,
}: {
  pkg: PackageListItem;
  lang: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const versions = pkg.recentCheckouts.slice(0, VERSION_CHIPS);
  const more = pkg.checkoutCount - versions.length;
  return (
    <li className="flex min-w-0 items-center gap-2 pe-2">
      <Link
        to="/$lang/packages/$packageId"
        params={{ lang, packageId: pkg.id }}
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <EcosystemIcon ecosystem={pkg.ecosystem} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{pkg.displayName}</span>
            {pkg.sshKey || pkg.isSnapshot ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <KeyRound aria-hidden="true" className="size-3" />
                {t("dashboard:packages.private")}
              </span>
            ) : null}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">{pkg.identifier}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {versions.length === 0 ? (
              <span>{t("dashboard:packages.noVersions")}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <span className="sr-only">{t("dashboard:packages.versionsLabel")}</span>
                {versions.map((checkout) => (
                  <span
                    key={checkout.id}
                    className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-foreground"
                  >
                    {describeResolvedFrom(checkout.resolvedFrom, checkout.sha).label}
                  </span>
                ))}
                {more > 0 ? (
                  <span>{t("dashboard:packages.moreVersions", { count: more })}</span>
                ) : null}
              </span>
            )}
            {pkg.lastUsedAt ? (
              <span>
                {t("dashboard:packages.lastUsed")} <TimeAgo value={pkg.lastUsedAt} />
              </span>
            ) : (
              <span>{t("dashboard:packages.notUsedYet")}</span>
            )}
          </div>
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={t("dashboard:packages.rowActions", { identifier: pkg.identifier })}
            />
          }
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem className="min-h-[44px]" onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
            {t("common:actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-[44px]" variant="destructive" onClick={onDelete}>
            <Trash aria-hidden="true" className="size-4" />
            {t("common:actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function PackageRowsSkeleton() {
  return (
    <ul className="divide-y" aria-hidden="true">
      {["a", "b", "c", "d"].map((row) => (
        <li key={row} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-4 w-48" />
          </div>
        </li>
      ))}
    </ul>
  );
}
