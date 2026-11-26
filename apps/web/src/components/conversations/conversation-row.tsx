import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ConversationCost } from "@/components/conversations/conversation-cost";
import { RunStatusPill } from "@/components/run-status-pill";
import { TimeAgo } from "@/components/time-ago";
import {
  type ConversationListItem,
  conversationVersion,
  formatElapsed,
  isActive,
} from "@/lib/conversations";

/**
 * One conversation in a list (Ongoing, history). A live one shows how long
 * it has been running, its steps and its cost so far, with a pulsing dot; a
 * finished one shows when it last moved and what it cost. The title is the
 * question's first line (agent-written over MCP): plain text.
 */
export function ConversationRow({
  item,
  lang,
  now,
  leading,
  actions,
}: {
  item: ConversationListItem;
  lang: string;
  /** The ticking clock for elapsed times (live rows only). */
  now: number;
  /** Before the link, outside it (the Pinned section's drag handle). */
  leading?: ReactNode;
  /** After the link, outside it (the row menu). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation(["dashboard"]);
  const run = item.latestRun;
  const live = item.ongoing && run !== null && isActive(run.status);
  const version = conversationVersion(item);
  const origin =
    item.origin === "mcp"
      ? (item.mcpConnectionLabel ?? t("dashboard:origin.mcp"))
      : t("dashboard:origin.web");
  const since = run?.startedAt ?? item.lastActivityAt;

  const link = (
    <Link
      to="/$lang/conversations/$conversationId"
      params={{ lang, conversationId: item.id }}
      // A stable handle for the browser checks: a finished conversation offers Delete.
      data-live={live ? "" : undefined}
      // Beside a handle or a menu the button already spaces the row: give the text the room.
      className={cn(
        "flex min-w-0 flex-1 items-start gap-3 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        leading === undefined ? "ps-4" : "ps-1",
        actions === undefined ? "pe-4" : "pe-2",
      )}
    >
      <span aria-hidden="true" className="relative mt-1.5 flex size-2.5 shrink-0">
        {live && run?.status === "running" ? (
          <span className="absolute inline-flex size-full rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-2.5 rounded-full",
            live
              ? run?.status === "running"
                ? "bg-emerald-500"
                : "bg-sky-500"
              : run?.status === "failed"
                ? "bg-destructive"
                : run?.status === "completed"
                  ? "bg-muted-foreground/40"
                  : "bg-muted-foreground/25",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Two lines before cutting, so similar questions stay apart on a phone. */}
        <span
          data-slot="conversation-title"
          className="line-clamp-2 text-sm font-medium text-pretty [overflow-wrap:anywhere]"
        >
          {item.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {run ? <RunStatusPill status={run.status} /> : null}
          <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
            {item.packageIdentifier}
            {version ? `@${version}` : ""}
          </span>
          <span className="min-w-0 truncate">{origin}</span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground tabular-nums">
        {live ? (
          <>
            <span title={t("dashboard:conversations.row.elapsed")}>
              {formatElapsed(now - new Date(since).getTime())}
            </span>
            <span>
              {t("dashboard:conversations.row.steps", { count: run?.iterations ?? 0 })}
              {" · "}
              <ConversationCost
                costUsdMicros={item.totalCostUsdMicros}
                unpricedCalls={item.totalUnpricedCalls}
                compact
              />
            </span>
          </>
        ) : (
          <>
            <TimeAgo value={item.lastActivityAt} now={now} />
            <span>
              <ConversationCost
                costUsdMicros={item.totalCostUsdMicros}
                unpricedCalls={item.totalUnpricedCalls}
                compact
              />
            </span>
          </>
        )}
      </span>
    </Link>
  );
  if (leading === undefined && actions === undefined) return link;
  return (
    <div className="flex min-w-0 items-center">
      {leading}
      {link}
      {actions ? <div className="shrink-0 pe-1">{actions}</div> : null}
    </div>
  );
}

/** Loading placeholder mirroring {@link ConversationRow}. */
export function ConversationRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => `row-${index}`).map((key) => (
        <div key={key} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="mt-1.5 size-2.5 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}
