import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@cockpit-context/ui/components/alert-dialog";
import { Button } from "@cockpit-context/ui/components/button";
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
import { TextareaField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilLine, Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { SegmentedControl } from "@/components/segmented-control";
import { type CheckoutRow, describeResolvedFrom, shortSha } from "@/lib/packages";
import { orpc } from "@/utils/orpc";

/**
 * A checkout's overviews and the checkout's own lifecycle: view, edit,
 * revert, regenerate, delete. The model-written overview is shared by every
 * user of the checkout; "your edited version" is the viewer's private
 * override, which their investigations read instead. Overviews are untrusted
 * markdown, rendered without raw HTML.
 */

function useInvalidateCheckouts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: orpc.repositories.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.packages.key() });
  };
}

function checkoutLabel(checkout: CheckoutRow) {
  return describeResolvedFrom(checkout.resolvedFrom, checkout.sha).label;
}

type OverviewTab = "yours" | "generated";

/** View details → Dialog. Shows the viewer's edited version (if any) and the model-written one. */
export function SummaryDialog({
  checkout,
  onOpenChange,
  onEdit,
  onRevert,
  onRegenerate,
  canRegenerate,
}: {
  checkout: CheckoutRow | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (checkout: CheckoutRow) => void;
  onRevert: (checkout: CheckoutRow) => void;
  onRegenerate: (checkout: CheckoutRow) => void;
  canRegenerate: (checkout: CheckoutRow) => boolean;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <Dialog open={checkout !== null} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t("common:actions.close")}
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {t("dashboard:checkouts.summary.title", {
              version: checkout ? checkoutLabel(checkout) : "",
            })}
          </DialogTitle>
        </DialogHeader>
        {checkout ? (
          <SummaryDialogBody
            // A fresh tab choice per checkout, and again once an override appears or goes.
            key={`${checkout.id}:${checkout.summaryOverride ? "own" : "model"}`}
            checkout={checkout}
            onClose={() => onOpenChange(false)}
            onEdit={() => onEdit(checkout)}
            onRevert={() => onRevert(checkout)}
            onRegenerate={() => onRegenerate(checkout)}
            canRegenerate={canRegenerate(checkout)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SummaryDialogBody({
  checkout,
  onClose,
  onEdit,
  onRevert,
  onRegenerate,
  canRegenerate,
}: {
  checkout: CheckoutRow;
  onClose: () => void;
  onEdit: () => void;
  onRevert: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const override = checkout.summaryOverride;
  const [tab, setTab] = useState<OverviewTab>(override ? "yours" : "generated");
  const showingOwn = override !== null && tab === "yours";
  return (
    <>
      {override ? (
        <SegmentedControl
          value={tab}
          onChange={setTab}
          ariaLabel={t("dashboard:checkouts.summary.versionPicker")}
          items={[
            { value: "yours", label: t("dashboard:checkouts.summary.yourVersion") },
            { value: "generated", label: t("dashboard:checkouts.summary.generatedVersion") },
          ]}
        />
      ) : null}
      <DialogDescription>
        {showingOwn
          ? t("dashboard:checkouts.summary.overrideNote")
          : t("dashboard:checkouts.summary.modelNote")}
        {!showingOwn && override ? ` ${t("dashboard:checkouts.summary.overrideInUse")}` : null}
      </DialogDescription>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pe-1">
        {showingOwn ? (
          <LazyMarkdown content={override.body} />
        ) : (
          <GeneratedOverview checkout={checkout} />
        )}
      </div>
      {showingOwn ? null : (
        <p className="text-xs text-muted-foreground text-pretty">
          {t("dashboard:checkouts.summary.regenerateNote")}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <Button variant="ghost" size="touch" onClick={onClose}>
          {t("common:actions.close")}
        </Button>
        {showingOwn ? (
          <Button variant="outline" size="touch" onClick={onRevert}>
            <Undo2 aria-hidden="true" className="size-4" />
            {t("dashboard:checkouts.summary.revert")}
          </Button>
        ) : (
          <Button variant="outline" size="touch" disabled={!canRegenerate} onClick={onRegenerate}>
            <Sparkles aria-hidden="true" className="size-4" />
            {t("dashboard:checkouts.summary.regenerate")}
          </Button>
        )}
        <Button variant="outline" size="touch" onClick={onEdit}>
          <PencilLine aria-hidden="true" className="size-4" />
          {override
            ? t("dashboard:checkouts.summary.editOwn")
            : t("dashboard:checkouts.summary.edit")}
        </Button>
      </div>
    </>
  );
}

function GeneratedOverview({ checkout }: { checkout: CheckoutRow }) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <div className="space-y-3">
      {checkout.summaryStatus === "pending" ? (
        <p className="text-sm text-muted-foreground">
          {t("dashboard:checkouts.summary.generatedPending")}
        </p>
      ) : null}
      {checkout.summary ? (
        <LazyMarkdown content={checkout.summary} />
      ) : checkout.summaryStatus === "pending" ? null : (
        <p className="text-sm text-muted-foreground">{t("dashboard:checkouts.summary.none")}</p>
      )}
    </div>
  );
}

const summarySchema = z.object({ summary: z.string().trim().min(1).max(20_000) });

/**
 * Edit → Sheet. Saves the viewer's own override; it starts from their
 * current edit, else from the model-written overview.
 */
export function EditSummarySheet({
  checkout,
  onOpenChange,
}: {
  checkout: CheckoutRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateCheckouts();
  const save = useMutation({
    ...orpc.repositories.updateSummary.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:checkouts.summary.saved"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:checkouts.summary.saveFailed" },
  });
  return (
    <Sheet
      open={checkout !== null}
      onOpenChange={(next) => (save.isPending ? null : onOpenChange(next))}
    >
      <SheetContent
        closeLabel={t("common:actions.close")}
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>
            {t("dashboard:checkouts.summary.editTitle", {
              version: checkout ? checkoutLabel(checkout) : "",
            })}
          </SheetTitle>
          <SheetDescription>{t("dashboard:checkouts.summary.editDescription")}</SheetDescription>
        </SheetHeader>
        {checkout ? (
          <SummaryForm
            key={checkout.id}
            initial={checkout.summaryOverride?.body ?? checkout.summary ?? ""}
            onCancel={() => onOpenChange(false)}
            onSubmit={async (summary) => {
              try {
                await save.mutateAsync({ checkoutId: checkout.id, summary });
              } catch {
                // Reported by the global mutation toast; the draft stays.
              }
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function SummaryForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (summary: string) => Promise<void>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { summary: initial },
    validators: { onChange: summarySchema },
    onSubmit: async ({ value }) => onSubmit(value.summary.trim()),
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-2">
        <form.Field name="summary">
          {(field) => (
            <TextareaField
              field={field}
              label={t("dashboard:checkouts.summary.label")}
              description={t("dashboard:checkouts.summary.markdownHint")}
              autoComplete="off"
              rows={18}
              maxLength={20_000}
              className="font-mono text-xs"
            />
          )}
        </form.Field>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t p-4 sm:flex-row sm:justify-end">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button
              type="button"
              variant="ghost"
              size="touch"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("common:actions.cancel")}
            </Button>
          )}
        </form.Subscribe>
        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

/**
 * Regenerate the model-written overview (one summary run: model spend). It
 * never touches anyone's edited version, so it needs no confirmation; the
 * toast says so when the viewer has one.
 */
export function useRegenerateSummary(packageId: string) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateCheckouts();
  const mutation = useMutation({
    ...orpc.repositories.regenerateSummary.mutationOptions({ onSuccess: invalidate }),
    meta: { errorFallbackKey: "dashboard:checkouts.summary.regenerateFailed" },
  });
  const regenerate = (checkout: CheckoutRow) => {
    const keepsEdit = checkout.summaryOverride !== null;
    mutation.mutate(
      { checkoutId: checkout.id, packageId },
      {
        onSuccess: (result) => {
          toast.success(
            !result.requested
              ? t("dashboard:checkouts.summary.alreadyRunning")
              : keepsEdit
                ? t("dashboard:checkouts.summary.regeneratingKeepsEdit")
                : t("dashboard:checkouts.summary.regenerating"),
          );
        },
      },
    );
  };
  return { regenerate, isPending: mutation.isPending };
}

/** Revert → AlertDialog: deletes the viewer's own edited version. */
export function ConfirmRevertDialog({
  checkout,
  onOpenChange,
}: {
  checkout: CheckoutRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateCheckouts();
  const revert = useMutation({
    ...orpc.repositories.revertSummary.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:checkouts.summary.reverted"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:checkouts.summary.revertFailed" },
  });
  return (
    <AlertDialog
      open={checkout !== null}
      onOpenChange={(next) => (revert.isPending ? null : onOpenChange(next))}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dashboard:checkouts.summary.revertTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("dashboard:checkouts.summary.revertDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]" disabled={revert.isPending}>
            {t("common:actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[44px]"
            disabled={revert.isPending}
            onClick={(event) => {
              // Stay open until the server answers; onSuccess closes it.
              event.preventDefault();
              if (checkout) revert.mutate({ checkoutId: checkout.id });
            }}
          >
            {t("dashboard:checkouts.summary.revertConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Delete → type-to-confirm on the short commit. The checkout is a cache, re-created on demand. */
export function DeleteCheckoutDialog({
  checkout,
  onOpenChange,
}: {
  checkout: CheckoutRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateCheckouts();
  const remove = useMutation({
    ...orpc.repositories.deleteCheckout.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:checkouts.delete.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:checkouts.delete.failed" },
  });
  return (
    <ConfirmDeleteDialog
      open={checkout !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:checkouts.delete.title", {
        version: checkout ? checkoutLabel(checkout) : "",
      })}
      description={t("dashboard:checkouts.delete.description")}
      confirmToken={checkout ? shortSha(checkout.sha) : ""}
      typePrompt={t("dashboard:checkouts.delete.typePrompt")}
      copyAriaLabel={t("dashboard:checkouts.delete.copy")}
      inputMode="text"
      isPending={remove.isPending}
      onConfirm={() => {
        if (checkout) remove.mutate({ checkoutId: checkout.id });
      }}
    />
  );
}
