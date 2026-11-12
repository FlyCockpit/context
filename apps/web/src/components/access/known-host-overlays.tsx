import { Button } from "@cockpit-context/ui/components/button";
import { Checkbox } from "@cockpit-context/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { Label } from "@cockpit-context/ui/components/label";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { type HostScan, hostLabel, parseScanTarget } from "@/lib/access";
import { orpc } from "@/utils/orpc";

const DIALOG_CLASS =
  "flex max-h-[calc(100dvh-2rem)] flex-col overflow-x-hidden overflow-y-auto sm:max-w-lg";

/**
 * Create → Dialog: scan a host, compare its fingerprints, trust the ones
 * that match. `ssh-keyscan` runs on the server against the checked public
 * address (private and loopback addresses are refused there).
 */
export function ScanHostDialog({
  open,
  onOpenChange,
  initialHost,
  initialPort,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialHost?: string;
  initialPort?: number;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [scan, setScan] = useState<HostScan | null>(null);
  const scanHost = useMutation({
    ...orpc.knownHosts.scan.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:access.knownHosts.scan.failed" },
  });
  const close = () => {
    if (scanHost.isPending) return;
    setScan(null);
    scanHost.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent closeLabel={t("common:actions.close")} className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle className="break-words">
            {scan
              ? t("dashboard:access.knownHosts.review.title", {
                  host: hostLabel(scan.host, scan.port),
                })
              : t("dashboard:access.knownHosts.scan.title")}
          </DialogTitle>
          <DialogDescription>
            {scan
              ? scan.pinned
                ? t("dashboard:access.knownHosts.review.pinnedDescription")
                : t("dashboard:access.knownHosts.review.description")
              : t("dashboard:access.knownHosts.scan.description")}
          </DialogDescription>
        </DialogHeader>
        {scan ? (
          scan.pinned ? (
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-primary-text"
                />
                <p className="text-pretty">
                  {t("dashboard:access.knownHosts.review.pinnedBody", { host: scan.host })}
                </p>
              </div>
              <Button type="button" size="touch" onClick={close}>
                {t("dashboard:access.knownHosts.review.done")}
              </Button>
            </div>
          ) : (
            <ReviewKeys
              scan={scan}
              onBack={() => {
                setScan(null);
                scanHost.reset();
              }}
              onDone={close}
            />
          )
        ) : open ? (
          <ScanForm
            initialHost={initialHost ?? ""}
            initialPort={initialPort ?? 22}
            onCancel={close}
            onSubmit={async (target) => {
              const result = await scanHost.mutateAsync(target).catch(() => null);
              if (result) setScan(result);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ScanForm({
  initialHost,
  initialPort,
  onSubmit,
  onCancel,
}: {
  initialHost: string;
  initialPort: number;
  onSubmit: (target: { host: string; port: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { host: initialHost, port: String(initialPort) },
    validators: {
      onSubmit: z.object({ host: z.string(), port: z.string() }).superRefine((value, ctx) => {
        const port = Number(value.port.trim());
        if (!/^\d{1,5}$/.test(value.port.trim()) || port < 1 || port > 65_535) {
          ctx.addIssue({
            code: "custom",
            path: ["port"],
            message: t("dashboard:access.knownHosts.form.portInvalid"),
          });
          return;
        }
        if (parseScanTarget(value.host, Number(value.port)) === null) {
          ctx.addIssue({
            code: "custom",
            path: ["host"],
            message: t("dashboard:access.knownHosts.form.hostInvalid"),
          });
        }
      }),
    },
    onSubmit: async ({ value }) => {
      const target = parseScanTarget(value.host, Number(value.port));
      if (target) await onSubmit(target);
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-[1fr_7rem]">
        <form.Field name="host">
          {(field) => (
            <TextField
              field={field}
              label={t("dashboard:access.knownHosts.form.host")}
              description={t("dashboard:access.knownHosts.form.hostHint")}
              placeholder={t("dashboard:access.knownHosts.form.hostPlaceholder")}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              inputClassName="font-mono"
            />
          )}
        </form.Field>
        <form.Field name="port">
          {(field) => (
            <TextField
              field={field}
              label={t("dashboard:access.knownHosts.form.port")}
              inputMode="numeric"
              autoComplete="off"
              maxLength={5}
              inputClassName="font-mono tabular-nums"
            />
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" size="touch" disabled={isSubmitting}>
              {isSubmitting
                ? t("dashboard:access.knownHosts.scan.pending")
                : t("dashboard:access.knownHosts.scan.submit")}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/** The scanned keys, none pre-selected: the person compares and picks. */
function ReviewKeys({
  scan,
  onBack,
  onDone,
}: {
  scan: HostScan;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const baseId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const confirm = useMutation({
    ...orpc.knownHosts.confirm.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:access.knownHosts.review.failed" },
  });
  const [busy, setBusy] = useState(false);

  const trust = async () => {
    setBusy(true);
    let saved = 0;
    for (const key of scan.keys) {
      if (!selected.has(key.fingerprint)) continue;
      const ok = await confirm
        .mutateAsync({
          host: scan.host,
          port: scan.port,
          keyType: key.keyType,
          publicKey: key.publicKey,
        })
        .then(() => true)
        .catch(() => false);
      if (!ok) break;
      saved += 1;
    }
    setBusy(false);
    if (saved > 0) {
      void queryClient.invalidateQueries({ queryKey: orpc.knownHosts.key() });
      toast.success(
        t("dashboard:access.knownHosts.review.success", {
          count: saved,
          host: hostLabel(scan.host, scan.port),
        }),
      );
    }
    if (saved === selected.size) onDone();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="note"
        className="flex min-w-0 items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      >
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <p className="text-pretty">{t("dashboard:access.knownHosts.review.compare")}</p>
      </div>
      <fieldset className="min-w-0 space-y-1">
        <legend className="mb-1 text-sm font-medium">
          {t("dashboard:access.knownHosts.review.keys", { count: scan.keys.length })}
        </legend>
        {scan.keys.map((key) => {
          const id = `${baseId}-${key.fingerprint}`;
          return (
            <div
              key={key.fingerprint}
              className="flex min-h-[44px] min-w-0 items-start gap-3 rounded-md px-1 py-2"
            >
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={selected.has(key.fingerprint)}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(key.fingerprint);
                    else next.delete(key.fingerprint);
                    return next;
                  })
                }
              />
              <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
                <span className="font-mono text-xs text-muted-foreground">{key.keyType}</span>
                <span className="font-mono text-sm break-all">{key.fingerprint}</span>
              </Label>
            </div>
          );
        })}
      </fieldset>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" size="touch" onClick={onBack} disabled={busy}>
          {t("common:actions.back")}
        </Button>
        <Button
          type="button"
          size="touch"
          disabled={busy || selected.size === 0}
          onClick={() => void trust()}
        >
          {busy
            ? t("dashboard:access.knownHosts.review.pending")
            : selected.size === 0
              ? t("dashboard:access.knownHosts.review.submitNone")
              : t("dashboard:access.knownHosts.review.submit", { count: selected.size })}
        </Button>
      </div>
    </div>
  );
}

/** Delete → AlertDialog with type-to-confirm on the host name. */
export function RemoveHostDialog({
  target,
  onOpenChange,
}: {
  target: { id: string; host: string; port: number; fingerprint: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const remove = useMutation({
    ...orpc.knownHosts.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.knownHosts.key() });
        toast.success(t("dashboard:access.knownHosts.remove.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.knownHosts.remove.failed" },
  });
  return (
    <ConfirmDeleteDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:access.knownHosts.remove.title")}
      description={
        <>
          {t("dashboard:access.knownHosts.remove.description")}{" "}
          <span className="font-mono break-all">{target?.fingerprint}</span>
        </>
      }
      confirmToken={target ? hostLabel(target.host, target.port) : ""}
      typePrompt={t("dashboard:access.knownHosts.remove.typePrompt")}
      copyAriaLabel={t("dashboard:access.knownHosts.remove.copy")}
      inputMode="url"
      confirmLabel={t("dashboard:access.knownHosts.remove.confirm")}
      pendingLabel={t("dashboard:access.knownHosts.remove.pending")}
      isPending={remove.isPending}
      onConfirm={() => {
        if (target) remove.mutate({ id: target.id });
      }}
    />
  );
}
