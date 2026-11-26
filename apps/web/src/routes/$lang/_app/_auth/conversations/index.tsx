import { AsyncCombobox } from "@cockpit-context/ui/components/async-combobox";
import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import { Input } from "@cockpit-context/ui/components/input";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useDebounce } from "@cockpit-context/ui/hooks/use-async-search";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MessagesSquare, X } from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useTranslation } from "react-i18next";

import { ConversationRowMenu } from "@/components/conversations/conversation-pin";
import {
  ConversationRow,
  ConversationRowsSkeleton,
} from "@/components/conversations/conversation-row";
import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { useNow } from "@/hooks/use-now";
import { useRunActivity } from "@/hooks/use-run-activity";
import { dedupeConversations } from "@/lib/conversations";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/conversations/")({
  staticData: { pendingShape: "list" },
  component: ConversationsPage,
});

const PAGE_LIMIT = 25;
const ORIGINS = ["all", "mcp", "web"] as const;
/** The server's bound on `conversations.list` search (packages/api/src/routers/conversations.ts). */
const SEARCH_MAX_LENGTH = 200;

/** The instance-wide retention period (COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS). */
function RetentionNote() {
  const { t } = useTranslation(["dashboard"]);
  const retention = useQuery(orpc.conversations.retention.queryOptions());
  return (
    <QueryBoundary
      query={retention}
      skeleton={<Skeleton aria-hidden="true" className="h-5 w-72 max-w-full" />}
      errorMessage={t("dashboard:conversations.retention.loadFailed")}
      errorClassName="items-start py-0 text-start"
    >
      {({ days }) => (
        <p className="text-sm text-pretty text-muted-foreground">
          {days > 0
            ? t("dashboard:conversations.retention.deletedAfter", { count: days })
            : t("dashboard:conversations.retention.keptUntilDeleted")}
        </p>
      )}
    </QueryBoundary>
  );
}

type PageParam = { segment: "ongoing" | "finished"; cursor: string | null };
type PackageOption = { id: string; identifier: string };

/**
 * Conversation history (docs/product.md): every
 * conversation, live ones first, cursor-paginated, searchable by question
 * and filterable by package and origin (all in the URL). Rows update live.
 */
function ConversationsPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const [origin, setOrigin] = useQueryState(
    "origin",
    parseAsStringLiteral(ORIGINS).withDefault("all"),
  );
  const [packageId, setPackageId] = useQueryState("package", parseAsString);
  const [search, setSearch] = useQueryState("q", parseAsString.withDefault(""));
  const debouncedSearch = useDebounce(search.trim(), 300);
  useRunActivity();

  const list = useInfiniteQuery(
    orpc.conversations.list.infiniteOptions({
      input: (page: PageParam) => ({
        limit: PAGE_LIMIT,
        segment: page.segment,
        cursor: page.cursor,
        packageId: packageId ?? undefined,
        origin: origin === "all" ? undefined : origin,
        search: debouncedSearch || undefined,
      }),
      initialPageParam: { segment: "ongoing", cursor: null } as PageParam,
      getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    }),
  );
  const items = dedupeConversations(list.data?.pages);
  const anyLive = items.some((item) => item.ongoing);
  const now = useNow(1_000, anyLive);
  const filtered = origin !== "all" || packageId !== null;

  // The picker shows a name, never the raw id from the URL (docs/development.md).
  const selected = useQuery(
    orpc.packages.get.queryOptions({ input: packageId ? { id: packageId } : skipToken }),
  );
  const selectedOption: PackageOption | null =
    packageId && selected.data
      ? { id: selected.data.id, identifier: selected.data.identifier }
      : null;

  const clearFilters = () => {
    void setOrigin(null);
    void setPackageId(null);
    void setSearch(null);
  };

  return (
    <PageShell>
      <div className="space-y-2">
        <PageHeader
          title={t("dashboard:pages.conversations.title")}
          description={t("dashboard:pages.conversations.description")}
        />
        <RetentionNote />
      </div>

      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <SegmentedControl
          ariaLabel={t("dashboard:conversations.filters.origin")}
          value={origin}
          onChange={(next) => void setOrigin(next === "all" ? null : next)}
          items={ORIGINS.map((value) => ({
            value,
            label: t(`dashboard:conversations.filters.origins.${value}`),
          }))}
        />
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="search"
            inputMode="search"
            autoComplete="off"
            maxLength={SEARCH_MAX_LENGTH}
            aria-label={t("dashboard:conversations.filters.search")}
            placeholder={t("dashboard:conversations.filters.searchPlaceholder")}
            value={search}
            onChange={(event) => void setSearch(event.target.value || null)}
            className="min-h-[44px] min-w-0 sm:flex-1 xl:w-64 xl:flex-none"
          />
          <div className="flex min-w-0 items-center gap-2 sm:flex-1 xl:w-80 xl:flex-none">
            <AsyncCombobox<PackageOption>
              className="min-h-[44px] min-w-0 flex-1"
              label={t("dashboard:conversations.filters.packageLabel")}
              value={selectedOption}
              onSelect={(item) => void setPackageId(item.id)}
              onSearch={async (query, signal) => {
                const page = await orpc.packages.list.call(
                  { limit: 10, search: query.trim() || undefined },
                  { signal },
                );
                return page.items.map((item) => ({ id: item.id, identifier: item.identifier }));
              }}
              getKey={(item) => item.id}
              getLabel={(item) => item.identifier}
              renderItem={(item) => <span className="font-mono text-sm">{item.identifier}</span>}
              placeholder={t("dashboard:conversations.filters.package")}
              searchPlaceholder={t("dashboard:conversations.filters.packageSearch")}
              emptyText={t("dashboard:conversations.filters.packageEmpty")}
            />
            {packageId ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                aria-label={t("dashboard:conversations.filters.clearPackage")}
                onClick={() => void setPackageId(null)}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<ConversationRowsSkeleton rows={5} />}
            errorMessage={t("dashboard:conversations.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              debouncedSearch ? (
                <EmptyState
                  icon={MessagesSquare}
                  title={t("dashboard:conversations.emptySearch.title", {
                    query: debouncedSearch,
                  })}
                  description={t("dashboard:conversations.emptySearch.description")}
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button variant="outline" size="touch" onClick={() => void setSearch(null)}>
                        {t("dashboard:conversations.filters.clearSearch")}
                      </Button>
                      {filtered ? (
                        <Button variant="ghost" size="touch" onClick={clearFilters}>
                          {t("dashboard:conversations.filters.clear")}
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ) : filtered ? (
                <EmptyState
                  icon={MessagesSquare}
                  title={t("dashboard:conversations.emptyFiltered.title")}
                  description={t("dashboard:conversations.emptyFiltered.description")}
                  action={
                    <Button variant="outline" size="touch" onClick={clearFilters}>
                      {t("dashboard:conversations.filters.clear")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={MessagesSquare}
                  title={t("dashboard:conversations.empty.title")}
                  description={t("dashboard:conversations.empty.description")}
                />
              )
            }
          >
            {() => (
              <ul className="divide-y">
                {items.map((item) => (
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
      <LoadMore
        onLoadMore={() => void list.fetchNextPage()}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
      />
    </PageShell>
  );
}
