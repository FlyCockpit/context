import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Lock, Plus, Server, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AccessRowsSkeleton,
  AccessSectionHeader,
  RowIcon,
} from "@/components/access/access-section";
import { RemoveHostDialog, ScanHostDialog } from "@/components/access/known-host-overlays";
import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { hostLabel, type KnownHost, parseKnownHostsSearch } from "@/lib/access";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/access/known-hosts")({
  // `?host=…&port=…` opens the scan prefilled (a clone failure links here).
  validateSearch: parseKnownHostsSearch,
  component: AccessKnownHostsPage,
});

const PAGE_LIMIT = 25;

/**
 * Confirmed SSH host keys (docs/product.md): scan
 * a host, compare and trust its fingerprints, remove one. The pinned GitHub,
 * GitLab and Bitbucket keys are listed read-only.
 */
function AccessKnownHostsPage() {
  const { t } = useTranslation(["dashboard"]);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [scanOpen, setScanOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<KnownHost | null>(null);
  const linkedHost = search.host;

  const list = useInfiniteQuery(
    orpc.knownHosts.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const hosts = list.data?.pages.flatMap((page) => page.items) ?? [];
  const addButton = (
    <Button size="touch" onClick={() => setScanOpen(true)}>
      <Plus aria-hidden="true" className="size-4" />
      {t("dashboard:access.knownHosts.scan.open")}
    </Button>
  );

  return (
    <div className="min-w-0 space-y-8">
      <section className="min-w-0 space-y-4" aria-labelledby="known-hosts-title">
        <AccessSectionHeader
          titleId="known-hosts-title"
          title={t("dashboard:access.knownHosts.title")}
          description={t("dashboard:access.knownHosts.description")}
          actions={addButton}
        />
        <Card className="py-0">
          <CardContent className="p-0">
            <QueryBoundary
              query={list}
              skeleton={<AccessRowsSkeleton rows={2} />}
              errorMessage={t("dashboard:access.knownHosts.loadFailed")}
              errorClassName="py-12"
              isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
              empty={
                <EmptyState
                  icon={Server}
                  title={t("dashboard:access.knownHosts.empty.title")}
                  description={t("dashboard:access.knownHosts.empty.body")}
                  action={addButton}
                />
              }
            >
              {() => (
                <>
                  <ul className="divide-y">
                    {hosts.map((host) => (
                      <KnownHostRow
                        key={host.id}
                        host={host}
                        onRemove={() => setRemoveTarget(host)}
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
      </section>

      <PinnedHosts />

      <ScanHostDialog
        // A new linked host is a new scan: remount the form with its values.
        key={linkedHost ? hostLabel(linkedHost, search.port ?? 22) : "manual"}
        open={scanOpen || linkedHost !== undefined}
        initialHost={linkedHost}
        initialPort={search.port}
        onOpenChange={(open) => {
          setScanOpen(open);
          if (!open && linkedHost !== undefined) {
            void navigate({ search: {}, replace: true });
          }
        }}
      />
      <RemoveHostDialog
        target={removeTarget}
        onOpenChange={(open) => (open ? null : setRemoveTarget(null))}
      />
    </div>
  );
}

function KnownHostRow({ host, onRemove }: { host: KnownHost; onRemove: () => void }) {
  const { t } = useTranslation(["dashboard"]);
  const label = hostLabel(host.host, host.port);
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <RowIcon icon={Server} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-sm font-medium">{label}</span>
          <span className="font-mono text-xs text-muted-foreground">{host.keyType}</span>
        </p>
        <p className="font-mono text-xs break-all text-muted-foreground">
          <span className="sr-only">{t("dashboard:access.knownHosts.fingerprint")} </span>
          {host.fingerprint}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("dashboard:access.knownHosts.trusted")} <TimeAgo value={host.createdAt} />
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-touch"
        className="shrink-0"
        aria-label={t("dashboard:access.knownHosts.remove.label", { host: label })}
        onClick={onRemove}
      >
        <Trash aria-hidden="true" className="size-4" />
      </Button>
    </li>
  );
}

/** github.com, gitlab.com and bitbucket.org: pinned in code, shown read-only. */
function PinnedHosts() {
  const { t } = useTranslation(["dashboard"]);
  const pinned = useQuery(orpc.knownHosts.pinned.queryOptions());
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="pinned-hosts-title">
      <AccessSectionHeader
        titleId="pinned-hosts-title"
        title={t("dashboard:access.knownHosts.pinned.title")}
        description={t("dashboard:access.knownHosts.pinned.description")}
      />
      <Card className="py-0">
        <CardContent className="p-0">
          {pinned.data ? (
            <ul className="divide-y">
              {pinned.data.items.map((item) => (
                <li key={item.host} className="flex min-w-0 items-start gap-3 px-4 py-3">
                  <RowIcon icon={Lock} muted />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-sm font-medium">{item.host}</span>
                      <StatusPill tone="muted">
                        {t("dashboard:access.knownHosts.pinned.badge")}
                      </StatusPill>
                    </p>
                    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
                      {item.keys.map((key) => (
                        <div key={key.fingerprint} className="contents">
                          <dt className="font-mono text-muted-foreground">{key.keyType}</dt>
                          <dd className="mb-1 font-mono break-all sm:mb-0">{key.fingerprint}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </li>
              ))}
            </ul>
          ) : pinned.isError ? (
            <InlineRetry
              className="py-8"
              message={t("dashboard:access.knownHosts.pinned.loadFailed")}
              onRetry={() => void pinned.refetch()}
            />
          ) : (
            <AccessRowsSkeleton rows={3} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
