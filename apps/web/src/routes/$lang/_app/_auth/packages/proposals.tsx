import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { TextareaField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Inbox, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { EcosystemIcon } from "@/components/packages/ecosystem-badge";
import { ApproveProposalDialog } from "@/components/packages/package-overlays";
import { BACK_LINK_CLASS, PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import type { Proposal } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/packages/proposals")({
  component: ProposalsPage,
});

const PAGE_LIMIT = 20;

/** Agent proposals (docs/product.md): pending first, then history. */
function ProposalsPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard", "common"]);
  const navigate = useNavigate();
  const [approving, setApproving] = useState<Proposal | null>(null);
  const [rejecting, setRejecting] = useState<Proposal | null>(null);

  const pending = useInfiniteQuery(
    orpc.proposals.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ status: "pending", limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const decided = useInfiniteQuery(
    orpc.proposals.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ status: "decided", limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );
  const pendingItems = pending.data?.pages.flatMap((page) => page.items) ?? [];
  const decidedItems = decided.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageShell>
      <div className="space-y-2">
        <Link to="/$lang/packages" params={{ lang }} className={BACK_LINK_CLASS}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("dashboard:proposals.backToPackages")}
        </Link>
        <PageHeader
          title={t("dashboard:proposals.title")}
          description={t("dashboard:proposals.description")}
        />
      </div>

      <section aria-labelledby="proposals-pending" className="space-y-3">
        <h2 id="proposals-pending" className="text-base font-semibold">
          {t("dashboard:proposals.pending")}
        </h2>
        <Card className="py-0">
          <CardContent className="p-0">
            <QueryBoundary
              query={pending}
              skeleton={<ProposalRowsSkeleton rows={2} />}
              errorMessage={t("dashboard:proposals.loadFailed")}
              errorClassName="py-10"
              isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
              empty={
                <EmptyState
                  icon={Inbox}
                  title={t("dashboard:proposals.emptyPending")}
                  description={t("dashboard:proposals.emptyPendingBody")}
                />
              }
            >
              {() => (
                <>
                  <ul className="divide-y">
                    {pendingItems.map((proposal) => (
                      <ProposalRow key={proposal.id} proposal={proposal} lang={lang}>
                        <div className="flex flex-wrap gap-2">
                          <Button size="touch" onClick={() => setApproving(proposal)}>
                            <Check aria-hidden="true" className="size-4" />
                            {t("dashboard:proposals.approve.action")}
                          </Button>
                          <Button
                            variant="outline"
                            size="touch"
                            onClick={() => setRejecting(proposal)}
                          >
                            <X aria-hidden="true" className="size-4" />
                            {t("dashboard:proposals.reject.action")}
                          </Button>
                        </div>
                      </ProposalRow>
                    ))}
                  </ul>
                  <LoadMore
                    hasNextPage={pending.hasNextPage}
                    isFetchingNextPage={pending.isFetchingNextPage}
                    onLoadMore={() => void pending.fetchNextPage()}
                  />
                </>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="proposals-history" className="space-y-3">
        <h2 id="proposals-history" className="text-base font-semibold">
          {t("dashboard:proposals.history")}
        </h2>
        <Card className="py-0">
          <CardContent className="p-0">
            <QueryBoundary
              query={decided}
              skeleton={<ProposalRowsSkeleton rows={2} />}
              errorMessage={t("dashboard:proposals.loadFailed")}
              errorClassName="py-10"
              isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
              empty={
                <EmptyState
                  title={t("dashboard:proposals.emptyHistory")}
                  description={t("dashboard:proposals.emptyHistoryBody")}
                />
              }
            >
              {() => (
                <>
                  <ul className="divide-y">
                    {decidedItems.map((proposal) => (
                      <ProposalRow key={proposal.id} proposal={proposal} lang={lang} decided />
                    ))}
                  </ul>
                  <LoadMore
                    hasNextPage={decided.hasNextPage}
                    isFetchingNextPage={decided.isFetchingNextPage}
                    onLoadMore={() => void decided.fetchNextPage()}
                  />
                </>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </section>

      <ApproveProposalDialog
        proposal={approving}
        onOpenChange={(open) => (open ? null : setApproving(null))}
        lang={lang}
        onApproved={({ packageId, created, identifier }) => {
          setApproving(null);
          const open = () =>
            void navigate({ to: "/$lang/packages/$packageId", params: { lang, packageId } });
          toast.success(
            created
              ? t("dashboard:proposals.approve.created", { identifier })
              : t("dashboard:proposals.approve.existing", { identifier }),
            { action: { label: t("dashboard:proposals.approve.open"), onClick: open } },
          );
        }}
      />
      <RejectProposalDialog proposal={rejecting} onClose={() => setRejecting(null)} />
    </PageShell>
  );
}

function ProposalRow({
  proposal,
  lang,
  decided = false,
  children,
}: {
  proposal: Proposal;
  lang: string;
  decided?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <EcosystemIcon ecosystem={proposal.ecosystem} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-medium">{proposal.identifier}</span>
            {decided ? <DecisionPill status={proposal.status} /> : null}
          </p>
          {/* Agent-written: rendered as plain text, clamped. */}
          <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap text-pretty">
            {proposal.reason}
          </p>
          <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">
              {proposal.connectionLabel
                ? t("dashboard:proposals.proposedBy", { connection: proposal.connectionLabel })
                : t("dashboard:proposals.proposedByUnknown")}
            </span>
            <TimeAgo value={proposal.createdAt} />
            {proposal.version ? (
              <span>{t("dashboard:proposals.askedVersion", { version: proposal.version })}</span>
            ) : null}
          </p>
          {decided && proposal.status === "rejected" && proposal.rejectionReason ? (
            <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {t("dashboard:proposals.rejectedBecause", { reason: proposal.rejectionReason })}
            </p>
          ) : null}
          {decided && proposal.status === "approved" && proposal.packageId ? (
            <Link
              to="/$lang/packages/$packageId"
              params={{ lang, packageId: proposal.packageId }}
              className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("dashboard:proposals.openPackage")}
            </Link>
          ) : null}
        </div>
      </div>
      {children}
    </li>
  );
}

function DecisionPill({ status }: { status: Proposal["status"] }) {
  const { t } = useTranslation(["dashboard", "common"]);
  if (status === "approved") {
    return <StatusPill tone="good">{t("dashboard:proposals.status.approved")}</StatusPill>;
  }
  if (status === "rejected") {
    return <StatusPill tone="muted">{t("dashboard:proposals.status.rejected")}</StatusPill>;
  }
  return <StatusPill tone="busy">{t("dashboard:proposals.status.pending")}</StatusPill>;
}

const rejectSchema = z.object({ reason: z.string().trim().max(10_000) });

/** Reject with an optional reason the agent can read back with `get_proposal`. */
function RejectProposalDialog({
  proposal,
  onClose,
}: {
  proposal: Proposal | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const reject = useMutation({
    ...orpc.proposals.reject.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.proposals.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
        toast.success(t("dashboard:proposals.reject.success"));
        onClose();
      },
    }),
    meta: { errorFallbackKey: "dashboard:proposals.reject.failed" },
  });

  return (
    <Dialog
      open={proposal !== null}
      onOpenChange={(next) => (next || reject.isPending ? null : onClose())}
    >
      <DialogContent closeLabel={t("common:actions.close")} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dashboard:proposals.reject.title")}</DialogTitle>
          <DialogDescription>
            {t("dashboard:proposals.reject.description", {
              identifier: proposal?.identifier ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        {proposal ? (
          <RejectForm
            key={proposal.id}
            pending={reject.isPending}
            onCancel={onClose}
            onSubmit={async (reason) => {
              try {
                await reject.mutateAsync({ id: proposal.id, reason: reason || undefined });
              } catch {
                // The global mutation toast reported it; the dialog stays open.
              }
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RejectForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { reason: "" },
    validators: { onChange: rejectSchema },
    onSubmit: async ({ value }) => onSubmit(value.reason.trim()),
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
      className="min-w-0 space-y-4"
    >
      <form.Field name="reason">
        {(field) => (
          <TextareaField
            field={field}
            label={t("dashboard:proposals.reject.reason")}
            description={t("dashboard:proposals.reject.reasonHint")}
            autoComplete="off"
            rows={3}
            maxLength={10_000}
          />
        )}
      </form.Field>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" size="touch" onClick={onCancel} disabled={pending}>
          {t("common:actions.cancel")}
        </Button>
        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button
              type="submit"
              variant="destructive"
              size="touch"
              disabled={!canSubmit || isSubmitting || pending}
            >
              {isSubmitting || pending
                ? t("dashboard:proposals.reject.pending")
                : t("dashboard:proposals.reject.submit")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function ProposalRowsSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="divide-y" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={`proposal-skeleton-${index}`} className="flex items-start gap-3 px-4 py-4">
          <Skeleton className="size-10 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-3 w-40" />
          </div>
        </li>
      ))}
    </ul>
  );
}
