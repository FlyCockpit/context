import { toast } from "@cockpit-context/ui/components/sileo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { repositoryLeased, type StorageCheckout, type StorageRepository } from "@/lib/admin";
import { describeResolvedFrom, formatBytes, shortSha } from "@/lib/packages";
import { errorReason, friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export type StorageDeleteTarget =
  | { kind: "repository"; repository: StorageRepository }
  | { kind: "checkout"; repository: StorageRepository; checkout: StorageCheckout };

function targetKey(target: StorageDeleteTarget): string {
  return target.kind === "repository"
    ? `repository:${target.repository.id}`
    : `checkout:${target.checkout.id}`;
}

function targetLeased(target: StorageDeleteTarget): boolean {
  return target.kind === "repository"
    ? repositoryLeased(target.repository)
    : target.checkout.leased;
}

/**
 * Delete a clone (type its URL) or a checkout (type its short commit). A
 * target a running question is reading needs `force`, which ends that run:
 * the dialog says so up front when the list shows a lease, and switches to
 * the forced form when the server refuses with CHECKOUT_LEASED (a lease taken
 * after the list loaded, or one beyond the checkouts the row lists).
 */
export function DeleteStorageDialog({
  target,
  onOpenChange,
}: {
  target: StorageDeleteTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation(["admin"]);
  const queryClient = useQueryClient();
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const force = target !== null && (targetLeased(target) || refusedKey === targetKey(target));

  const remove = useMutation({
    ...orpc.adminStorage.delete.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          t("admin:storage.delete.success", {
            size: formatBytes(result.freedBytes, i18n.language),
          }),
        );
        void queryClient.invalidateQueries({ queryKey: orpc.adminStorage.key() });
        setRefusedKey(null);
        onOpenChange(false);
      },
      onError: (error) => {
        if (target && errorReason(error) === "CHECKOUT_LEASED") {
          setRefusedKey(targetKey(target));
          return;
        }
        toast.error(friendly(error, t("admin:storage.delete.failed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const isRepository = target?.kind === "repository";
  const title =
    target === null
      ? ""
      : target.kind === "repository"
        ? t("admin:storage.delete.repositoryTitle")
        : t("admin:storage.delete.checkoutTitle", {
            version: describeResolvedFrom(target.checkout.resolvedFrom, target.checkout.sha).label,
          });
  const body =
    target === null
      ? ""
      : target.kind === "repository"
        ? t("admin:storage.delete.repositoryDescription", {
            count: target.repository.checkoutCount,
          })
        : t("admin:storage.delete.checkoutDescription");

  return (
    <ConfirmDeleteDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setRefusedKey(null);
        onOpenChange(open);
      }}
      title={title}
      description={
        <>
          {body}
          {isRepository && target?.repository.isSnapshot ? (
            <span className="mt-2 block font-medium">
              {t("admin:storage.snapshotDeleteWarning")}
            </span>
          ) : null}
          {force ? (
            <span className="mt-2 block font-medium text-destructive">
              {t("admin:storage.delete.leasedWarning")}
            </span>
          ) : null}
        </>
      }
      confirmToken={
        target === null
          ? ""
          : target.kind === "repository"
            ? target.repository.remoteUrl
            : shortSha(target.checkout.sha)
      }
      typePrompt={
        isRepository ? t("admin:storage.delete.typeUrl") : t("admin:storage.delete.typeCommit")
      }
      copyAriaLabel={
        isRepository ? t("admin:storage.delete.copyUrl") : t("admin:storage.delete.copyCommit")
      }
      inputMode={isRepository ? "url" : "text"}
      confirmLabel={force ? t("admin:storage.delete.forceConfirm") : undefined}
      isPending={remove.isPending}
      onConfirm={() => {
        if (!target) return;
        remove.mutate({
          kind: target.kind,
          id: target.kind === "repository" ? target.repository.id : target.checkout.id,
          force,
        });
      }}
    />
  );
}
