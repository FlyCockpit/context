import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { toast } from "@cockpit-context/ui/components/sileo";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Ban, KeyRound, MoreVertical, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AccessRowsSkeleton,
  AccessSectionHeader,
  CredentialDates,
  CredentialStatePill,
  RowIcon,
} from "@/components/access/access-section";
import { FlagSwitches } from "@/components/access/flag-switches";
import {
  CreateTokenDialog,
  RenameTokenSheet,
  RevokeTokenDialog,
} from "@/components/access/token-overlays";
import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { type ConnectionFlags, type McpToken, normalizeFlags } from "@/lib/access";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/access/tokens")({
  component: AccessTokensPage,
});

const PAGE_LIMIT = 25;

/** MCP API tokens (docs/mcp.md): create (secret shown once), flags, rename, revoke. */
function AccessTokensPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<McpToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const list = useInfiniteQuery(
    orpc.mcpTokens.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const tokens = list.data?.pages.flatMap((page) => page.items) ?? [];
  const createButton = (
    <Button size="touch" onClick={() => setCreateOpen(true)}>
      <Plus aria-hidden="true" className="size-4" />
      {t("dashboard:access.tokens.create.open")}
    </Button>
  );

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="tokens-title">
      <AccessSectionHeader
        titleId="tokens-title"
        title={t("dashboard:access.tokens.title")}
        description={
          <>
            {t("dashboard:access.tokens.description")}{" "}
            <Link
              to="/$lang/access/connections"
              params={{ lang }}
              className="font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("dashboard:access.tokens.preferOAuth")}
            </Link>
          </>
        }
        actions={createButton}
      />
      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<AccessRowsSkeleton />}
            errorMessage={t("dashboard:access.tokens.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                icon={KeyRound}
                title={t("dashboard:access.tokens.empty.title")}
                description={t("dashboard:access.tokens.empty.body")}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {createButton}
                    <Link
                      to="/$lang/access/connections"
                      params={{ lang }}
                      className={cn(buttonVariants({ variant: "outline", size: "touch" }), "gap-2")}
                    >
                      {t("dashboard:access.tokens.empty.oauth")}
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Link>
                  </div>
                }
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {tokens.map((token) => (
                    <TokenRow
                      key={token.id}
                      token={token}
                      onRename={() => setRenameTarget(token)}
                      onRevoke={() => setRevokeTarget({ id: token.id, name: token.name })}
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

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RenameTokenSheet
        token={renameTarget}
        onOpenChange={(open) => (open ? null : setRenameTarget(null))}
      />
      <RevokeTokenDialog
        token={revokeTarget}
        onOpenChange={(open) => (open ? null : setRevokeTarget(null))}
      />
    </section>
  );
}

function TokenRow({
  token,
  onRename,
  onRevoke,
}: {
  token: McpToken;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const active = token.state === "active";
  // The switches show the requested flags while the save (and the refetch it
  // awaits) is in flight, so a toggle never flickers back.
  const update = useMutation({
    ...orpc.mcpTokens.update.mutationOptions({
      onSuccess: async () => {
        toast.success(t("dashboard:access.flags.saved"));
        await queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() });
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.flags.saveFailed" },
  });
  const shown: ConnectionFlags =
    update.isPending && update.variables
      ? normalizeFlags({
          allowPropose: update.variables.allowPropose ?? token.allowPropose,
          autoApprove: update.variables.autoApprove ?? token.autoApprove,
        })
      : { allowPropose: token.allowPropose, autoApprove: token.autoApprove };

  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <RowIcon icon={KeyRound} muted={!active} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium">{token.name}</span>
          <CredentialStatePill state={token.state} kind="token" />
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          <span className="sr-only">{t("dashboard:access.tokens.prefix")} </span>
          {token.lookupPrefix}…
        </p>
        <CredentialDates
          createdAt={token.createdAt}
          lastUsedAt={token.lastUsedAt}
          expiresAt={active ? token.expiresAt : undefined}
        />
        <FlagSwitches
          variant="row"
          value={shown}
          disabled={!active || update.isPending}
          onChange={(next) => update.mutate({ id: token.id, ...next })}
        />
      </div>
      {active ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-touch"
                aria-label={t("dashboard:access.tokens.rowActions", { name: token.name })}
              />
            }
          >
            <MoreVertical aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem className="min-h-[44px]" onClick={onRename}>
              <Pencil aria-hidden="true" className="size-4" />
              {t("dashboard:access.tokens.rename.open")}
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" variant="destructive" onClick={onRevoke}>
              <Ban aria-hidden="true" className="size-4" />
              {t("dashboard:access.revoke")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
