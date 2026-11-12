import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@cockpit-context/ui/components/sheet";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { PackageForm } from "@/components/packages/package-form";
import {
  emptyPackageForm,
  hasUpdates,
  type PackageDetail,
  type Proposal,
  packageToFormValues,
  pastedKeyInput,
  proposalToFormValues,
  toApproveInput,
  toCreateInput,
  toUpdateInput,
} from "@/lib/packages";
import { orpc } from "@/utils/orpc";

/** Package changes move the list, the detail page, the nav badge and Getting started. */
function useInvalidatePackages() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: orpc.packages.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.proposals.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
  };
}

const FORM_DIALOG_CLASS =
  "flex max-h-[calc(100dvh-2rem)] flex-col overflow-x-hidden overflow-y-auto sm:max-w-lg";

/** Create → Dialog (docs/development.md). */
export function CreatePackageDialog({
  open,
  onOpenChange,
  lang,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  onCreated: (packageId: string) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidatePackages();
  const create = useMutation({
    gcTime: 0,
    ...orpc.packages.create.mutationOptions({
      onSuccess: (pkg) => {
        invalidate();
        toast.success(t("dashboard:packages.create.success", { identifier: pkg.identifier }));
        onCreated(pkg.id);
      },
    }),
    meta: { errorFallbackKey: "dashboard:packages.create.failed" },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (create.isPending ? null : onOpenChange(next))}>
      <DialogContent closeLabel={t("common:actions.close")} className={FORM_DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("dashboard:packages.create.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:packages.create.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <PackageForm
            mode="create"
            lang={lang}
            initialValues={emptyPackageForm()}
            onSubmit={async (values) => {
              try {
                return await create.mutateAsync(toCreateInput(values));
              } finally {
                create.reset();
              }
            }}
            onCancel={() => onOpenChange(false)}
            submitLabel={t("dashboard:packages.create.submit")}
            pendingLabel={t("dashboard:packages.create.pending")}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Approve → the create dialog, prefilled from the proposal; the owner can edit every field. */
export function ApproveProposalDialog({
  proposal,
  onOpenChange,
  lang,
  onApproved,
}: {
  proposal: Proposal | null;
  onOpenChange: (open: boolean) => void;
  lang: string;
  onApproved: (result: { packageId: string; created: boolean; identifier: string }) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidatePackages();
  const approve = useMutation({
    gcTime: 0,
    ...orpc.proposals.approve.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:proposals.approve.failed" },
  });

  return (
    <Dialog
      open={proposal !== null}
      onOpenChange={(next) => (approve.isPending ? null : onOpenChange(next))}
    >
      <DialogContent closeLabel={t("common:actions.close")} className={FORM_DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("dashboard:proposals.approve.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:proposals.approve.description")}</DialogDescription>
        </DialogHeader>
        {proposal ? (
          <PackageForm
            key={proposal.id}
            mode="approve"
            lang={lang}
            initialValues={proposalToFormValues(proposal)}
            intro={<ProposalSummary proposal={proposal} />}
            onSubmit={async (values) => {
              const result = await approve
                .mutateAsync(toApproveInput(proposal.id, values))
                .finally(() => approve.reset());
              invalidate();
              onApproved({
                packageId: result.packageId,
                created: result.created,
                identifier: proposal.identifier,
              });
            }}
            onCancel={() => onOpenChange(false)}
            submitLabel={t("dashboard:proposals.approve.submit")}
            pendingLabel={t("dashboard:proposals.approve.pending")}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Who proposed it and why. The reason is agent-written: plain text only. */
function ProposalSummary({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <div className="min-w-0 space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="text-xs text-muted-foreground">
        {proposal.connectionLabel
          ? t("dashboard:proposals.proposedBy", { connection: proposal.connectionLabel })
          : t("dashboard:proposals.proposedByUnknown")}
      </p>
      <p className="break-words whitespace-pre-wrap">{proposal.reason}</p>
      {proposal.version ? (
        <p className="text-xs text-muted-foreground">
          {t("dashboard:proposals.askedVersion", { version: proposal.version })}
        </p>
      ) : null}
    </div>
  );
}

/** Edit → Sheet. Loads the full package (with notes) itself, so any list can open it by id. */
export function EditPackageSheet({
  packageId,
  onOpenChange,
  lang,
}: {
  packageId: string | null;
  onOpenChange: (open: boolean) => void;
  lang: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidatePackages();
  const pkg = useQuery(
    orpc.packages.get.queryOptions({ input: packageId ? { id: packageId } : skipToken }),
  );
  const update = useMutation({
    ...orpc.packages.update.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:packages.edit.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:packages.edit.failed" },
  });

  return (
    <Sheet
      open={packageId !== null}
      onOpenChange={(next) => (update.isPending ? null : onOpenChange(next))}
    >
      <SheetContent
        closeLabel={t("common:actions.close")}
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>{t("dashboard:packages.edit.title")}</SheetTitle>
          <SheetDescription>{t("dashboard:packages.edit.description")}</SheetDescription>
        </SheetHeader>
        {packageId === null ? null : pkg.data ? (
          <PackageForm
            key={`${pkg.data.id}:${String(pkg.data.updatedAt)}`}
            mode="edit"
            lang={lang}
            initialValues={packageToFormValues(pkg.data)}
            bodyClassName="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-2"
            footerClassName="border-t p-4"
            onSubmit={async (values) => {
              const input = toUpdateInput(pkg.data.id, packageToFormValues(pkg.data), values);
              if (!hasUpdates(input)) {
                onOpenChange(false);
                return;
              }
              await update.mutateAsync(input);
            }}
            onCancel={() => onOpenChange(false)}
            submitLabel={t("common:actions.saveChanges")}
            pendingLabel={t("common:actions.saving")}
          />
        ) : pkg.isError ? (
          <InlineRetry
            className="px-4"
            message={t("dashboard:packages.detail.loadFailed")}
            onRetry={() => pkg.refetch()}
          />
        ) : (
          <div className="space-y-4 px-4" aria-hidden="true">
            {["a", "b", "c", "d"].map((row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full md:h-8" />
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Delete → AlertDialog with type-to-confirm on the identifier. */
export function DeletePackageDialog({
  pkg,
  onOpenChange,
  onDeleted,
}: {
  pkg: { id: string; identifier: string; isSnapshot?: boolean } | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePackages();
  const remove = useMutation({
    ...orpc.packages.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
        toast.success(t("dashboard:packages.delete.success"));
        onOpenChange(false);
        onDeleted?.();
      },
    }),
    meta: { errorFallbackKey: "dashboard:packages.delete.failed" },
  });

  return (
    <ConfirmDeleteDialog
      open={pkg !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:packages.delete.title")}
      description={t(
        pkg?.isSnapshot
          ? "dashboard:packages.snapshot.deleteWarning"
          : "dashboard:packages.delete.description",
      )}
      confirmToken={pkg?.identifier ?? ""}
      typePrompt={t("dashboard:packages.delete.typePrompt")}
      copyAriaLabel={t("dashboard:packages.delete.copy")}
      inputMode="url"
      isPending={remove.isPending}
      onConfirm={() => {
        if (pkg) remove.mutate({ id: pkg.id });
      }}
    />
  );
}

/** An inline fetch: mutation variables contain a secret, so reset them after every attempt. */
export function UpdateSnapshotDialog({
  pkg,
  lang,
  onOpenChange,
}: {
  pkg: PackageDetail | null;
  lang: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidatePackages();
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.packages.updateSnapshot.mutationOptions(),
    gcTime: 0,
    meta: { errorFallbackKey: "dashboard:packages.snapshot.failed" },
  });
  return (
    <Dialog
      open={pkg !== null}
      onOpenChange={(next) => (update.isPending ? null : onOpenChange(next))}
    >
      <DialogContent closeLabel={t("common:actions.close")} className={FORM_DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("dashboard:packages.snapshot.update")}</DialogTitle>
          <DialogDescription>{t("dashboard:packages.snapshot.hint")}</DialogDescription>
        </DialogHeader>
        {pkg ? (
          <PackageForm
            mode="snapshot-update"
            lang={lang}
            initialValues={{ ...packageToFormValues(pkg), keyMode: "once" }}
            submitLabel={t("dashboard:packages.snapshot.update")}
            pendingLabel={t("dashboard:packages.snapshot.updating")}
            onCancel={() => onOpenChange(false)}
            onSubmit={async (values) => {
              try {
                await update.mutateAsync({ id: pkg.id, key: pastedKeyInput(values) });
                invalidate();
                void queryClient.invalidateQueries({ queryKey: orpc.sshKeys.key() });
                toast.success(t("dashboard:packages.snapshot.updated"));
                onOpenChange(false);
              } finally {
                update.reset();
              }
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
