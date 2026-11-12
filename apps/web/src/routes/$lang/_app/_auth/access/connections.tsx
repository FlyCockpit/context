import { Button } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { CopyField } from "@cockpit-context/ui/components/copy-field";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Ban, Bot, Link2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AccessRowsSkeleton,
  AccessSectionHeader,
  CredentialDates,
  CredentialStatePill,
  RowIcon,
} from "@/components/access/access-section";
import { FlagSwitches } from "@/components/access/flag-switches";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { useHomeStatus } from "@/hooks/use-home-status";
import {
  type ConnectionFlags,
  claudeOAuthCommand,
  type McpConnection,
  normalizeFlags,
} from "@/lib/access";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/access/connections")({
  component: AccessConnectionsPage,
});

const PAGE_LIMIT = 25;

/**
 * OAuth MCP connections (docs/mcp.md): how to connect an agent with
 * OAuth, then every client the user approved on the consent page, with its
 * flags and revoke.
 */
function AccessConnectionsPage() {
  const { t } = useTranslation(["dashboard"]);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null);
  const list = useInfiniteQuery(
    orpc.mcpConnections.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const connections = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="connections-title">
      <ConnectGuide />
      <AccessSectionHeader
        titleId="connections-title"
        title={t("dashboard:access.connections.title")}
        description={t("dashboard:access.connections.description")}
      />
      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<AccessRowsSkeleton />}
            errorMessage={t("dashboard:access.connections.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                icon={Link2}
                title={t("dashboard:access.connections.empty.title")}
                description={t("dashboard:access.connections.empty.body")}
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {connections.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      onRevoke={(label) => setRevokeTarget({ id: connection.id, label })}
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
      <RevokeConnectionDialog
        connection={revokeTarget}
        onOpenChange={(open) => (open ? null : setRevokeTarget(null))}
      />
    </section>
  );
}

/** Connect with OAuth: the Claude Code command, then `/mcp` → Authenticate. */
function ConnectGuide() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard", "common", "errors"]);
  const status = useHomeStatus();
  const mcpUrl = status.data?.mcpUrl ?? null;
  const onCopied = () => toast.success(t("common:actions.copied"));
  const onCopyError = () => toast.error(t("errors:couldNotCopy"));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:access.connections.guide.title")}</CardTitle>
        <CardDescription className="text-pretty">
          {t("dashboard:access.connections.guide.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="min-w-0 space-y-4">
          <GuideStep index={1} title={t("dashboard:access.connections.guide.add")}>
            {mcpUrl ? (
              <CopyField
                value={claudeOAuthCommand(mcpUrl)}
                copyLabel={t("dashboard:access.connections.guide.copyCommand")}
                onCopied={onCopied}
                onCopyError={onCopyError}
              />
            ) : status.isError ? (
              <InlineRetry
                variant="destructive"
                message={t("dashboard:access.mcpUrlFailed")}
                onRetry={() => void status.refetch()}
              />
            ) : (
              <Skeleton className="h-11 w-full" />
            )}
          </GuideStep>
          <GuideStep index={2} title={t("dashboard:access.connections.guide.authenticate")}>
            <p className="text-sm text-pretty text-muted-foreground">
              {t("dashboard:access.connections.guide.authenticateBody")}
            </p>
          </GuideStep>
          <GuideStep index={3} title={t("dashboard:access.connections.guide.approve")}>
            <p className="text-sm text-pretty text-muted-foreground">
              {t("dashboard:access.connections.guide.approveBody")}
            </p>
          </GuideStep>
        </ol>
        <div className="mt-5 min-w-0 space-y-1.5 border-t pt-4">
          <p className="text-sm font-medium">
            {t("dashboard:access.connections.guide.otherClients")}
          </p>
          {mcpUrl ? (
            <CopyField
              value={mcpUrl}
              copyLabel={t("dashboard:access.connections.guide.copyUrl")}
              onCopied={onCopied}
              onCopyError={onCopyError}
            />
          ) : status.isError ? null : (
            // Step 1 already shows the retry for the same query.
            <Skeleton className="h-11 w-full" />
          )}
          <p className="text-xs text-pretty text-muted-foreground">
            {t("dashboard:access.connections.guide.otherClientsBody")}{" "}
            <Link
              to="/$lang/access/tokens"
              params={{ lang }}
              className="font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("dashboard:access.connections.guide.useToken")}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function GuideStep({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 gap-3">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary-text tabular-nums"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function ConnectionRow({
  connection,
  onRevoke,
}: {
  connection: McpConnection;
  onRevoke: (label: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const active = connection.state === "active";
  // Client-supplied at registration: rendered as plain text only.
  const label = connection.clientName ?? connection.clientId;
  const update = useMutation({
    ...orpc.mcpConnections.update.mutationOptions({
      onSuccess: async () => {
        toast.success(t("dashboard:access.flags.saved"));
        await queryClient.invalidateQueries({ queryKey: orpc.mcpConnections.key() });
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.flags.saveFailed" },
  });
  const shown: ConnectionFlags =
    update.isPending && update.variables
      ? normalizeFlags({
          allowPropose: update.variables.allowPropose ?? connection.allowPropose,
          autoApprove: update.variables.autoApprove ?? connection.autoApprove,
        })
      : { allowPropose: connection.allowPropose, autoApprove: connection.autoApprove };

  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <RowIcon icon={Bot} muted={!active} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium">{label}</span>
          <CredentialStatePill state={connection.state} kind="connection" />
        </p>
        {connection.clientName ? (
          <p className="truncate font-mono text-xs text-muted-foreground">
            <span className="sr-only">{t("dashboard:access.connections.clientId")} </span>
            {connection.clientId}
          </p>
        ) : null}
        <CredentialDates createdAt={connection.createdAt} lastUsedAt={connection.lastUsedAt} />
        <FlagSwitches
          variant="row"
          value={shown}
          disabled={!active || update.isPending}
          onChange={(next) => update.mutate({ id: connection.id, ...next })}
        />
      </div>
      {active ? (
        <Button
          variant="ghost"
          size="touch"
          className="shrink-0 text-destructive hover:text-destructive"
          aria-label={t("dashboard:access.connections.revokeLabel", { name: label })}
          onClick={() => onRevoke(label)}
        >
          <Ban aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">{t("dashboard:access.revoke")}</span>
        </Button>
      ) : null}
    </li>
  );
}

/** Revoke → AlertDialog with type-to-confirm on the client's name. */
function RevokeConnectionDialog({
  connection,
  onOpenChange,
}: {
  connection: { id: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    ...orpc.mcpConnections.revoke.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.mcpConnections.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
        toast.success(t("dashboard:access.connections.revoke.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.connections.revoke.failed" },
  });
  return (
    <ConfirmDeleteDialog
      open={connection !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:access.connections.revoke.title")}
      description={t("dashboard:access.connections.revoke.description")}
      confirmToken={connection?.label ?? ""}
      typePrompt={t("dashboard:access.connections.revoke.typePrompt")}
      copyAriaLabel={t("dashboard:access.connections.revoke.copy")}
      inputMode="text"
      confirmLabel={t("dashboard:access.revoke")}
      pendingLabel={t("dashboard:access.revoking")}
      isPending={revoke.isPending}
      onConfirm={() => {
        if (connection) revoke.mutate({ id: connection.id });
      }}
    />
  );
}
