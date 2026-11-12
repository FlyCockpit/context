import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Eye, Fingerprint, KeyRound, MoreVertical, Plus, Trash, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AccessRowsSkeleton,
  AccessSectionHeader,
  CredentialDates,
  RowIcon,
} from "@/components/access/access-section";
import {
  DeleteKeyDialog,
  GenerateKeyDialog,
  ImportKeyDialog,
  PublicKeyDialog,
} from "@/components/access/ssh-key-overlays";
import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import type { SshKey } from "@/lib/access";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/access/ssh-keys")({
  component: AccessSshKeysPage,
});

const PAGE_LIMIT = 25;

/**
 * SSH keys for private repositories (docs/product.md): generate (shows the public key), import, view the public
 * half, delete. Private halves never reach the browser.
 */
function AccessSshKeysPage() {
  const { t } = useTranslation(["dashboard"]);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<SshKey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const list = useInfiniteQuery(
    orpc.sshKeys.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const keys = list.data?.pages.flatMap((page) => page.items) ?? [];
  const actions = (
    <>
      <Button variant="outline" size="touch" onClick={() => setImportOpen(true)}>
        <Upload aria-hidden="true" className="size-4" />
        {t("dashboard:access.sshKeys.import.open")}
      </Button>
      <Button size="touch" onClick={() => setGenerateOpen(true)}>
        <Plus aria-hidden="true" className="size-4" />
        {t("dashboard:access.sshKeys.generate.open")}
      </Button>
    </>
  );

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="ssh-keys-title">
      <AccessSectionHeader
        titleId="ssh-keys-title"
        title={t("dashboard:access.sshKeys.title")}
        description={t("dashboard:access.sshKeys.description")}
        actions={actions}
      />
      <Card className="py-0">
        <CardContent className="p-0">
          <QueryBoundary
            query={list}
            skeleton={<AccessRowsSkeleton />}
            errorMessage={t("dashboard:access.sshKeys.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                icon={Fingerprint}
                title={t("dashboard:access.sshKeys.empty.title")}
                description={t("dashboard:access.sshKeys.empty.body")}
                action={<div className="flex flex-wrap justify-center gap-2">{actions}</div>}
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {keys.map((key) => (
                    <SshKeyRow
                      key={key.id}
                      sshKey={key}
                      onView={() => setViewTarget(key)}
                      onDelete={() => setDeleteTarget({ id: key.id, name: key.name })}
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

      <GenerateKeyDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <ImportKeyDialog open={importOpen} onOpenChange={setImportOpen} />
      <PublicKeyDialog
        sshKey={viewTarget}
        onOpenChange={(open) => (open ? null : setViewTarget(null))}
      />
      <DeleteKeyDialog
        sshKey={deleteTarget}
        onOpenChange={(open) => (open ? null : setDeleteTarget(null))}
      />
    </section>
  );
}

function SshKeyRow({
  sshKey,
  onView,
  onDelete,
}: {
  sshKey: SshKey;
  onView: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <li className="flex min-w-0 items-start gap-2 pe-2">
      <button
        type="button"
        onClick={onView}
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <RowIcon icon={KeyRound} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-medium">{sshKey.name}</span>
            <StatusPill tone={sshKey.source === "generated" ? "info" : "muted"}>
              {t(`dashboard:access.sshKeys.source.${sshKey.source}`)}
            </StatusPill>
            <span className="font-mono text-xs text-muted-foreground">{sshKey.algorithm}</span>
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            <span className="sr-only">{t("dashboard:access.sshKeys.fingerprint")} </span>
            {sshKey.fingerprint}
          </p>
          <CredentialDates createdAt={sshKey.createdAt} lastUsedAt={sshKey.lastUsedAt} />
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-touch"
              className="mt-2"
              aria-label={t("dashboard:access.sshKeys.rowActions", { name: sshKey.name })}
            />
          }
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem className="min-h-[44px]" onClick={onView}>
            <Eye aria-hidden="true" className="size-4" />
            {t("dashboard:access.sshKeys.view.open")}
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
