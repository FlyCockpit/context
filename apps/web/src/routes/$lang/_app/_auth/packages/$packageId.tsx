import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { CopyField } from "@cockpit-context/ui/components/copy-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import {
  useInfiniteQuery,
  useMutation,
  usePrefetchInfiniteQuery,
  usePrefetchQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  MessageSquarePlus,
  MessagesSquare,
  MoreVertical,
  Pencil,
  PencilLine,
  RefreshCw,
  Sparkles,
  Tag,
  Trash,
  Undo2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { AskDialog, type AskTarget } from "@/components/packages/ask-dialog";
import {
  ConfirmRevertDialog,
  DeleteCheckoutDialog,
  EditSummarySheet,
  SummaryDialog,
  useRegenerateSummary,
} from "@/components/packages/checkout-overlays";
import { EcosystemBadge, EcosystemIcon } from "@/components/packages/ecosystem-badge";
import {
  DeletePackageDialog,
  EditPackageSheet,
  UpdateSnapshotDialog,
} from "@/components/packages/package-overlays";
import { BACK_LINK_CLASS, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { RunStatusPill } from "@/components/run-status-pill";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import {
  type CheckoutRow,
  describeResolvedFrom,
  formatBytes,
  type PackageDetail,
  shortSha,
} from "@/lib/packages";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/packages/$packageId")({
  component: PackageDetailPage,
});

const CHECKOUT_PAGE_LIMIT = 20;
const RECENT_CONVERSATIONS = 5;
/** While an overview or a checkout is being made, the table refreshes itself. */
const BUSY_REFRESH_MS = 5_000;

/**
 * The checkouts table and recent-conversations queries need only the URL's
 * package id, so the page starts them alongside `packages.get` and the cards
 * pick them up from the cache by the same key.
 */
const checkoutsInfiniteOptions = (packageId: string) =>
  orpc.repositories.listCheckouts.infiniteOptions({
    input: (cursor: string | undefined) => ({
      packageId,
      limit: CHECKOUT_PAGE_LIMIT,
      cursor,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

const recentConversationsOptions = (packageId: string) =>
  orpc.conversations.list.queryOptions({
    input: { packageId, limit: RECENT_CONVERSATIONS },
  });

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "NOT_FOUND" ||
      (error as { status?: unknown }).status === 404)
  );
}

function PackageDetailPage() {
  const { lang, packageId } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const pkg = useQuery(orpc.packages.get.queryOptions({ input: { id: packageId } }));
  // Started now rather than when the cards mount; a failure surfaces in the card.
  usePrefetchInfiniteQuery({
    ...checkoutsInfiniteOptions(packageId),
    meta: { skipGlobalErrorToast: true },
  });
  usePrefetchQuery({
    ...recentConversationsOptions(packageId),
    meta: { skipGlobalErrorToast: true },
  });

  if (pkg.isPending) return <DetailSkeleton />;
  if (pkg.data === undefined) {
    return (
      <PageShell>
        <BackLink lang={lang} />
        {isNotFound(pkg.error) ? (
          <EmptyState
            icon={FileText}
            title={t("dashboard:packages.detail.notFound")}
            description={t("dashboard:packages.detail.notFoundBody")}
          />
        ) : (
          <InlineRetry
            className="py-12"
            message={t("dashboard:packages.detail.loadFailed")}
            onRetry={() => pkg.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <PackageDetailView lang={lang} pkg={pkg.data} />;
}

function BackLink({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Link to="/$lang/packages" params={{ lang }} className={BACK_LINK_CLASS}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t("dashboard:packages.detail.back")}
    </Link>
  );
}

function PackageDetailView({ lang, pkg }: { lang: string; pkg: PackageDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const navigate = useNavigate();
  const [ask, setAsk] = useState<AskTarget | null>(null);
  const [editing, setEditing] = useState(false);
  const [updatingSnapshot, setUpdatingSnapshot] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <PageShell>
      <div className="space-y-2">
        <BackLink lang={lang} />
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <EcosystemIcon ecosystem={pkg.ecosystem} className="mt-1" />
            <header className="min-w-0 space-y-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{pkg.displayName}</h1>
              <p className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono text-sm text-muted-foreground">
                  {pkg.identifier}
                </span>
                <EcosystemBadge ecosystem={pkg.ecosystem} />
                {pkg.isSnapshot ? (
                  <StatusPill tone="muted">{t("dashboard:packages.snapshot.badge")}</StatusPill>
                ) : null}
              </p>
            </header>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="touch" onClick={() => setAsk({ kind: "default" })}>
              <MessageSquarePlus aria-hidden="true" className="size-4" />
              {t("dashboard:packages.detail.ask")}
            </Button>
            {pkg.isSnapshot ? (
              <Button variant="outline" size="touch" onClick={() => setUpdatingSnapshot(true)}>
                {t("dashboard:packages.snapshot.update")}
              </Button>
            ) : null}
            <Button variant="outline" size="touch" onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" className="size-4" />
              {t("common:actions.edit")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-touch"
                    aria-label={t("dashboard:packages.rowActions", { identifier: pkg.identifier })}
                  />
                }
              >
                <MoreVertical aria-hidden="true" className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  className="min-h-[44px]"
                  variant="destructive"
                  onClick={() => setDeleting(true)}
                >
                  <Trash aria-hidden="true" className="size-4" />
                  {t("dashboard:packages.delete.action")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <SettingsCard pkg={pkg} onEdit={() => setEditing(true)} />
      <CheckoutsCard
        pkg={pkg}
        onAsk={(checkout) => {
          const target = describeResolvedFrom(checkout.resolvedFrom, checkout.sha);
          setAsk({
            kind: "ref",
            value: target.kind === "tag" || target.kind === "branch" ? target.label : checkout.sha,
          });
        }}
      />
      <ConversationsCard lang={lang} pkg={pkg} onAsk={() => setAsk({ kind: "default" })} />

      <AskDialog
        // A new target is a new form.
        key={ask ? `${ask.kind}:${"value" in ask ? ask.value : ""}` : "closed"}
        pkg={pkg}
        initialTarget={ask ?? { kind: "default" }}
        open={ask !== null}
        onOpenChange={(open) => (open ? null : setAsk(null))}
        lang={lang}
      />
      <EditPackageSheet packageId={editing ? pkg.id : null} onOpenChange={setEditing} lang={lang} />
      <UpdateSnapshotDialog
        pkg={updatingSnapshot ? pkg : null}
        lang={lang}
        onOpenChange={setUpdatingSnapshot}
      />
      <DeletePackageDialog
        pkg={deleting ? pkg : null}
        onOpenChange={setDeleting}
        onDeleted={() => void navigate({ to: "/$lang/packages", params: { lang } })}
      />
    </PageShell>
  );
}

// ── Settings ──

function SettingsCard({ pkg, onEdit }: { pkg: PackageDetail; onEdit: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <Card>
      <CardHeader className="flex min-w-0 flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t("dashboard:packages.detail.settings")}</CardTitle>
          <CardDescription>{t("dashboard:packages.detail.settingsBody")}</CardDescription>
        </div>
        <Button variant="ghost" size="touch" onClick={onEdit}>
          <Pencil aria-hidden="true" className="size-4" />
          {t("common:actions.edit")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("dashboard:packages.form.gitUrl")}
          </p>
          <CopyField
            value={pkg.gitUrl}
            copyLabel={t("dashboard:packages.detail.copyGitUrl")}
            onCopied={() => toast.success(t("common:actions.copied"))}
          />
        </div>
        <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Setting label={t("dashboard:packages.detail.repository")}>
            <RepositoryStatus pkg={pkg} />
          </Setting>
          <Setting label={t("dashboard:packages.form.sshKey")}>
            {pkg.sshKey ? (
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{pkg.sshKey.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {pkg.sshKey.fingerprint}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t(
                  pkg.isSnapshot
                    ? "dashboard:packages.snapshot.once"
                    : "dashboard:packages.detail.publicRepo",
                )}
              </span>
            )}
          </Setting>
          <Setting label={t("dashboard:packages.form.subdirectory")}>
            <Mono value={pkg.subdirectory} empty={t("dashboard:packages.detail.wholeRepo")} />
          </Setting>
          <Setting label={t("dashboard:packages.form.tagPattern")}>
            <Mono value={pkg.tagPattern} empty={t("dashboard:packages.detail.tagPatternAuto")} />
          </Setting>
          <Setting label={t("dashboard:packages.form.defaultRef")}>
            <Mono
              value={pkg.defaultRef}
              empty={
                pkg.repository?.defaultBranch
                  ? t("dashboard:packages.detail.remoteDefault", {
                      branch: pkg.repository.defaultBranch,
                    })
                  : t("dashboard:packages.detail.remoteDefaultUnknown")
              }
            />
          </Setting>
          <Setting label={t("dashboard:packages.lastUsed")}>
            <TimeAgo value={pkg.lastUsedAt} />
          </Setting>
        </dl>
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t("dashboard:packages.form.notes")}
          </p>
          {pkg.notes ? (
            <p className="text-sm break-words whitespace-pre-wrap">{pkg.notes}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("dashboard:packages.detail.noNotes")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Mono({ value, empty }: { value: string | null; empty: string }) {
  if (!value) return <span className="text-muted-foreground">{empty}</span>;
  return <span className="block truncate font-mono text-sm">{value}</span>;
}

const REPOSITORY_TONE: Record<string, PillTone> = {
  pending: "muted",
  cloning: "busy",
  ready: "good",
  failed: "bad",
};

function RepositoryStatus({ pkg }: { pkg: PackageDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const repository = pkg.repository;
  if (!repository) {
    return (
      <span className="text-muted-foreground">
        {t(
          pkg.isSnapshot
            ? "dashboard:packages.snapshot.update"
            : "dashboard:packages.detail.notCloned",
        )}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <StatusPill tone={REPOSITORY_TONE[repository.status] ?? "muted"}>
        {t(`dashboard:packages.repositoryStatus.${repository.status}`)}
      </StatusPill>
      {repository.lastFetchedAt ? (
        <span className="text-xs text-muted-foreground">
          {t(
            pkg.isSnapshot
              ? "dashboard:packages.snapshot.lastUpdated"
              : "dashboard:packages.detail.fetched",
          )}{" "}
          <TimeAgo value={repository.lastFetchedAt} />
        </span>
      ) : null}
    </span>
  );
}

// ── Checkouts ──

function CheckoutsCard({
  pkg,
  onAsk,
}: {
  pkg: PackageDetail;
  onAsk: (checkout: CheckoutRow) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  // The dialog follows the live row (by id), so it updates after a save,
  // revert or regeneration.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CheckoutRow | null>(null);
  const [reverting, setReverting] = useState<CheckoutRow | null>(null);
  const [deleting, setDeleting] = useState<CheckoutRow | null>(null);

  const checkouts = useInfiniteQuery({
    ...checkoutsInfiniteOptions(pkg.id),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((row) => row.status === "pending" || row.summaryStatus === "pending"),
      )
        ? BUSY_REFRESH_MS
        : false,
  });
  const rows = checkouts.data?.pages.flatMap((page) => page.items) ?? [];
  const viewing = rows.find((row) => row.id === viewingId) ?? null;

  const refresh = useMutation({
    ...orpc.repositories.refresh.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.packages.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.repositories.key() });
        toast.success(
          result.queued
            ? t("dashboard:checkouts.refresh.queued")
            : t("dashboard:checkouts.refresh.notCloned"),
        );
      },
    }),
    meta: { errorFallbackKey: "dashboard:checkouts.refresh.failed" },
  });
  const regenerate = useRegenerateSummary(pkg.id);

  return (
    <Card>
      <CardHeader className="flex min-w-0 flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t("dashboard:checkouts.title")}</CardTitle>
          <CardDescription className="max-w-prose text-pretty">
            {t("dashboard:checkouts.description")}
          </CardDescription>
        </div>
        {pkg.isSnapshot ? null : (
          <Button
            variant="outline"
            size="touch"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate({ packageId: pkg.id })}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-4", refresh.isPending && "motion-safe:animate-spin")}
            />
            {t("dashboard:checkouts.refresh.action")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <QueryBoundary
          query={checkouts}
          skeleton={<CheckoutSkeleton />}
          errorMessage={t("dashboard:checkouts.loadFailed")}
          errorClassName="py-10"
          isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
          empty={
            <EmptyState
              icon={GitBranch}
              title={t("dashboard:checkouts.empty")}
              description={t("dashboard:checkouts.emptyBody")}
            />
          }
        >
          {() => (
            <>
              <WideContent>
                <table className="w-full min-w-[44rem] text-sm">
                  <thead className="border-y bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-start font-medium">
                        {t("dashboard:checkouts.columns.version")}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t("dashboard:checkouts.columns.commit")}
                      </th>
                      <th scope="col" className="px-3 py-2 text-end font-medium">
                        {t("dashboard:checkouts.columns.size")}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t("dashboard:checkouts.columns.lastUsed")}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {t("dashboard:checkouts.columns.overview")}
                      </th>
                      <th scope="col" className="px-4 py-2 text-end font-medium">
                        <span className="sr-only">{t("dashboard:checkouts.columns.actions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((checkout) => (
                      <CheckoutTableRow
                        key={checkout.id}
                        checkout={checkout}
                        onAsk={() => onAsk(checkout)}
                        onView={() => setViewingId(checkout.id)}
                        onEdit={() => setEditing(checkout)}
                        onRevert={() => setReverting(checkout)}
                        onRegenerate={() => regenerate.regenerate(checkout)}
                        regenerateDisabled={!canRegenerate(checkout) || regenerate.isPending}
                        onDelete={() => setDeleting(checkout)}
                      />
                    ))}
                  </tbody>
                </table>
              </WideContent>
              <LoadMore
                hasNextPage={checkouts.hasNextPage}
                isFetchingNextPage={checkouts.isFetchingNextPage}
                onLoadMore={() => void checkouts.fetchNextPage()}
              />
            </>
          )}
        </QueryBoundary>
      </CardContent>

      <SummaryDialog
        checkout={viewing}
        onOpenChange={(open) => (open ? null : setViewingId(null))}
        onEdit={(checkout) => {
          setViewingId(null);
          setEditing(checkout);
        }}
        onRevert={setReverting}
        onRegenerate={regenerate.regenerate}
        canRegenerate={(checkout) => canRegenerate(checkout) && !regenerate.isPending}
      />
      <EditSummarySheet
        checkout={editing}
        onOpenChange={(open) => (open ? null : setEditing(null))}
      />
      <ConfirmRevertDialog
        checkout={reverting}
        onOpenChange={(open) => (open ? null : setReverting(null))}
      />
      <DeleteCheckoutDialog
        checkout={deleting}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
      />
    </Card>
  );
}

const SUMMARY_TONE: Record<CheckoutRow["summaryStatus"], PillTone> = {
  none: "muted",
  pending: "busy",
  ready: "good",
  failed: "bad",
};

/** Regenerating needs a ready checkout and no generation already in flight. */
function canRegenerate(checkout: CheckoutRow) {
  return checkout.summaryStatus !== "pending" && checkout.status === "ready";
}

const TARGET_ICON = {
  tag: Tag,
  branch: GitBranch,
  commit: GitCommitHorizontal,
  npmGitHead: GitCommitHorizontal,
} as const;

function CheckoutTableRow({
  checkout,
  onAsk,
  onView,
  onEdit,
  onRevert,
  onRegenerate,
  regenerateDisabled,
  onDelete,
}: {
  checkout: CheckoutRow;
  onAsk: () => void;
  onView: () => void;
  onEdit: () => void;
  onRevert: () => void;
  onRegenerate: () => void;
  regenerateDisabled: boolean;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const target = describeResolvedFrom(checkout.resolvedFrom, checkout.sha);
  const Icon = TARGET_ICON[target.kind];
  const hasOverride = checkout.summaryOverride !== null;
  const hasSummary = (checkout.summary !== null && checkout.summary !== "") || hasOverride;
  const statusLabel = t(`dashboard:checkouts.summaryStatus.${checkout.summaryStatus}`);
  return (
    <tr className="align-middle">
      <td className="max-w-56 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate font-mono">{target.label}</span>
            <span className="block text-xs text-muted-foreground">
              {t(`dashboard:checkouts.kind.${target.kind}`)}
            </span>
          </span>
          {checkout.status === "ready" ? null : (
            <StatusPill tone={checkout.status === "failed" ? "bad" : "busy"}>
              {t(`dashboard:checkouts.status.${checkout.status}`)}
            </StatusPill>
          )}
        </span>
      </td>
      <td className="px-3 py-2">
        <code className="font-mono text-xs" title={checkout.sha}>
          {shortSha(checkout.sha)}
        </code>
      </td>
      <td className="px-3 py-2 text-end tabular-nums">
        {formatBytes(checkout.diskBytes, i18n.language)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <TimeAgo value={checkout.lastUsedAt} />
        {checkout.leased ? (
          <span className="ms-2">
            <StatusPill tone="busy">{t("dashboard:checkouts.inUse")}</StatusPill>
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {hasSummary ? (
          <button
            type="button"
            onClick={onView}
            aria-label={t("dashboard:checkouts.summary.viewStatus", {
              status: hasOverride
                ? `${statusLabel}, ${t("dashboard:checkouts.summary.overrideBadge")}`
                : statusLabel,
            })}
            className="inline-flex min-h-[44px] flex-wrap items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <StatusPill
              tone={SUMMARY_TONE[checkout.summaryStatus]}
              className="underline-offset-2 hover:underline"
            >
              {statusLabel}
            </StatusPill>
            {hasOverride ? (
              <StatusPill tone="info" className="underline-offset-2 hover:underline">
                {t("dashboard:checkouts.summary.overrideBadge")}
              </StatusPill>
            ) : null}
          </button>
        ) : (
          <StatusPill tone={SUMMARY_TONE[checkout.summaryStatus]}>{statusLabel}</StatusPill>
        )}
      </td>
      <td className="px-4 py-2 text-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-touch"
                aria-label={t("dashboard:checkouts.actions", { version: target.label })}
              />
            }
          >
            <MoreVertical aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="min-h-[44px]" onClick={onAsk}>
              <MessageSquarePlus aria-hidden="true" className="size-4" />
              {t("dashboard:checkouts.askThis")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-[44px]" disabled={!hasSummary} onClick={onView}>
              <FileText aria-hidden="true" className="size-4" />
              {t("dashboard:checkouts.summary.view")}
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" onClick={onEdit}>
              <PencilLine aria-hidden="true" className="size-4" />
              {hasOverride
                ? t("dashboard:checkouts.summary.editOwn")
                : t("dashboard:checkouts.summary.edit")}
            </DropdownMenuItem>
            {hasOverride ? (
              <DropdownMenuItem className="min-h-[44px]" onClick={onRevert}>
                <Undo2 aria-hidden="true" className="size-4" />
                {t("dashboard:checkouts.summary.revert")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className="min-h-[44px]"
              disabled={regenerateDisabled}
              onClick={onRegenerate}
            >
              <Sparkles aria-hidden="true" className="size-4" />
              {t("dashboard:checkouts.summary.regenerate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-[44px]"
              variant="destructive"
              disabled={checkout.leased}
              onClick={onDelete}
            >
              <Trash aria-hidden="true" className="size-4" />
              {checkout.leased
                ? t("dashboard:checkouts.delete.leased")
                : t("dashboard:checkouts.delete.action")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="divide-y border-t" aria-hidden="true">
      {["a", "b"].map((row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

// ── Recent conversations ──

function ConversationsCard({
  lang,
  pkg,
  onAsk,
}: {
  lang: string;
  pkg: PackageDetail;
  onAsk: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const conversations = useQuery(recentConversationsOptions(pkg.id));
  return (
    <Card>
      <CardHeader className="flex min-w-0 flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t("dashboard:packages.detail.conversations")}</CardTitle>
          <CardDescription>{t("dashboard:packages.detail.conversationsBody")}</CardDescription>
        </div>
        <Link
          to="/$lang/conversations"
          params={{ lang }}
          className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "gap-2")}
        >
          <MessagesSquare aria-hidden="true" className="size-4" />
          {t("dashboard:packages.detail.allConversations")}
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        <QueryBoundary
          query={conversations}
          skeleton={
            <div className="space-y-3 border-t px-4 py-3" aria-hidden="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          }
          errorMessage={t("dashboard:packages.detail.conversationsFailed")}
          errorClassName="py-8"
          isEmpty={(data) => data.items.length === 0}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title={t("dashboard:packages.detail.noConversations")}
              description={t("dashboard:packages.detail.noConversationsBody")}
              action={
                <Button size="touch" onClick={onAsk}>
                  <MessageSquarePlus aria-hidden="true" className="size-4" />
                  {t("dashboard:packages.detail.ask")}
                </Button>
              }
            />
          }
        >
          {(data) => (
            <ul className="divide-y border-t">
              {data.items.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    to="/$lang/conversations/$conversationId"
                    params={{ lang, conversationId: conversation.id }}
                    className="flex min-w-0 flex-col gap-1 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {/* The title is the question's first line, agent-written over MCP: plain text. */}
                    <span className="truncate text-sm font-medium">{conversation.title}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {conversation.latestRun ? (
                        <RunStatusPill status={conversation.latestRun.status} />
                      ) : null}
                      <span className="truncate">
                        {conversation.origin === "mcp"
                          ? (conversation.mcpConnectionLabel ?? t("dashboard:origin.mcp"))
                          : t("dashboard:origin.web")}
                      </span>
                      {conversation.resolvedFrom && conversation.commitSha ? (
                        <span className="font-mono">
                          {
                            describeResolvedFrom(conversation.resolvedFrom, conversation.commitSha)
                              .label
                          }
                        </span>
                      ) : null}
                      <TimeAgo value={conversation.lastActivityAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <PageShell>
      <div className="space-y-6" aria-hidden="true">
        <Skeleton className="h-5 w-24" />
        <div className="flex items-start gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </PageShell>
  );
}
