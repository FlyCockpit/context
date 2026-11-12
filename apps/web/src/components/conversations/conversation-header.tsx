import { Button } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { BACK_LINK_CLASS } from "@/components/page-shell";
import { RunStatusPill } from "@/components/run-status-pill";
import {
  type ConversationViewState,
  conversationTotals,
  conversationVersion,
  formatTokens,
  formatUsdMicros,
  isActive,
  latestMainRun,
} from "@/lib/conversations";
import { shortSha } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

/**
 * The conversation's header: its question, the package and version it
 * reads (with the commit), where it came from, the latest run's status
 * (and phase while live), and what the whole conversation cost.
 */
export function ConversationHeader({
  state,
  lang,
  reconnecting,
}: {
  state: ConversationViewState;
  lang: string;
  /** The live stream dropped and is coming back. */
  reconnecting: boolean;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const { conversation } = state;
  const main = latestMainRun(state);
  const live = main !== null && isActive(main.status);
  const totals = conversationTotals(state);
  const version = conversationVersion(conversation);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const origin =
    conversation.origin === "mcp"
      ? (conversation.mcpConnectionLabel ?? t("dashboard:origin.mcp"))
      : t("dashboard:origin.web");

  return (
    <header className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Link to="/$lang/conversations" params={{ lang }} className={BACK_LINK_CLASS}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("dashboard:pages.conversation.back")}
        </Link>
        {live ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            className="text-muted-foreground hover:text-destructive"
            aria-label={t("dashboard:conversation.delete.action")}
            title={t("dashboard:conversation.delete.action")}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash aria-hidden="true" className="size-4" />
          </Button>
        )}
      </div>
      {/* The question's first line (agent-written over MCP): plain text. */}
      <h1 className="line-clamp-2 text-lg font-semibold tracking-tight break-words sm:text-xl">
        {conversation.title}
      </h1>
      <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">{t("dashboard:conversation.header.package")}</dt>
          <dd className="min-w-0 truncate font-mono">
            {conversation.packageId ? (
              <Link
                to="/$lang/packages/$packageId"
                params={{ lang, packageId: conversation.packageId }}
                className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {conversation.packageIdentifier}
              </Link>
            ) : (
              <span title={t("dashboard:conversation.header.packageDeleted")}>
                {conversation.packageIdentifier}
              </span>
            )}
            {version ? <span>@{version}</span> : null}
          </dd>
        </div>
        {conversation.commitSha ? (
          <div className="flex items-center gap-1">
            <dt>{t("dashboard:conversation.header.commit")}</dt>
            <dd className="font-mono" title={conversation.commitSha}>
              {shortSha(conversation.commitSha)}
            </dd>
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-1">
          <dt>{t("dashboard:conversation.header.origin")}</dt>
          <dd className="min-w-0 truncate">{origin}</dd>
        </div>
        <div className="flex items-center gap-1 tabular-nums">
          <dt>{t("dashboard:conversation.header.cost")}</dt>
          <dd>
            {formatUsdMicros(totals.costUsdMicros, i18n.language)}
            {" · "}
            {t("dashboard:conversation.header.tokens", {
              input: formatTokens(totals.inputTokens, i18n.language),
              output: formatTokens(totals.outputTokens, i18n.language),
            })}
          </dd>
        </div>
        {main ? (
          <div className="flex items-center gap-1.5" aria-live="polite">
            <dt className="sr-only">{t("dashboard:conversation.header.status")}</dt>
            <dd className="flex items-center gap-1.5">
              <RunStatusPill status={main.status} />
              {live && main.phase ? (
                <span>{t(`dashboard:conversation.phaseShort.${main.phase}`)}</span>
              ) : null}
              {reconnecting ? <span>{t("dashboard:conversation.reconnecting")}</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <DeleteConversationDialog
        id={conversation.id}
        lang={lang}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </header>
  );
}

function DeleteConversationDialog({
  id,
  lang,
  open,
  onOpenChange,
}: {
  id: string;
  lang: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation(
    orpc.conversations.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
        toast.success(t("dashboard:conversation.delete.done"));
        onOpenChange(false);
        void navigate({ to: "/$lang/conversations", params: { lang } });
      },
    }),
  );
  const token = t("dashboard:conversation.delete.token");
  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dashboard:conversation.delete.title")}
      description={t("dashboard:conversation.delete.description")}
      confirmToken={token}
      typePrompt={t("dashboard:conversation.delete.typePrompt", { token })}
      copyAriaLabel={t("dashboard:conversation.delete.copy")}
      inputMode="text"
      isPending={remove.isPending}
      onConfirm={() => remove.mutate({ id })}
    />
  );
}
