import { Button } from "@cockpit-context/ui/components/button";
import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextareaField, TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { DEPLOY_KEY_DOCS, type SshKey } from "@/lib/access";
import { orpc } from "@/utils/orpc";

/** Matches the server's `shortText` cap and its private-key cap. */
const NAME_MAX = 120;
const PRIVATE_KEY_MAX = 16_384;
/** OpenSSH keeps at most 1023 bytes of an askpass answer (the server checks it too). */
const PASSPHRASE_MAX_BYTES = 1_023;
const utf8 = new TextEncoder();

const DIALOG_CLASS =
  "flex max-h-[calc(100dvh-2rem)] flex-col overflow-x-hidden overflow-y-auto sm:max-w-lg";

function useInvalidateKeys() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: orpc.sshKeys.key() });
}

function nameSchema(t: (key: string, options?: Record<string, unknown>) => string) {
  return z
    .string()
    .trim()
    .min(1, t("dashboard:access.sshKeys.form.nameRequired"))
    .max(NAME_MAX, t("dashboard:access.sshKeys.form.nameTooLong", { max: NAME_MAX }));
}

/**
 * The public half of a key, ready to paste into a git host, with the deploy
 * key docs for the three hosts Cockpit Context knows. The private half never reaches
 * the browser.
 */
function PublicKeyPanel({ sshKey }: { sshKey: Pick<SshKey, "publicKey" | "fingerprint"> }) {
  const { t } = useTranslation(["dashboard", "common", "errors"]);
  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{t("dashboard:access.sshKeys.publicKey")}</p>
        <CodeSnippet
          code={sshKey.publicKey}
          copyLabel={t("dashboard:access.sshKeys.copyPublicKey")}
          preClassName="whitespace-pre-wrap break-all"
          onCopied={() => toast.success(t("common:actions.copied"))}
          onCopyError={() => toast.error(t("errors:couldNotCopy"))}
        />
        <p className="text-xs text-muted-foreground">
          {t("dashboard:access.sshKeys.fingerprint")}{" "}
          <span className="font-mono break-all text-foreground">{sshKey.fingerprint}</span>
        </p>
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{t("dashboard:access.sshKeys.deployKey.title")}</p>
        <p className="text-sm text-pretty text-muted-foreground">
          {t("dashboard:access.sshKeys.deployKey.body")}
        </p>
        <ul className="flex min-w-0 flex-wrap gap-x-4">
          {DEPLOY_KEY_DOCS.map((doc) => (
            <li key={doc.host}>
              <a
                href={doc.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t(`dashboard:access.sshKeys.deployKey.${doc.host}`)}
                <ExternalLink aria-hidden="true" className="size-3.5" />
                <span className="sr-only">{t("dashboard:access.opensInNewTab")}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Create → Dialog: name the key, then show its public half. */
export function GenerateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateKeys();
  const [created, setCreated] = useState<SshKey | null>(null);
  const generate = useMutation({
    ...orpc.sshKeys.generate.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:access.sshKeys.generate.failed" },
  });
  const close = () => {
    if (generate.isPending) return;
    setCreated(null);
    generate.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent closeLabel={t("common:actions.close")} className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>
            {created
              ? t("dashboard:access.sshKeys.generate.createdTitle", { name: created.name })
              : t("dashboard:access.sshKeys.generate.title")}
          </DialogTitle>
          <DialogDescription>
            {created
              ? t("dashboard:access.sshKeys.generate.createdDescription")
              : t("dashboard:access.sshKeys.generate.description")}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex min-w-0 flex-col gap-4">
            <PublicKeyPanel sshKey={created} />
            <Button type="button" size="touch" onClick={close}>
              {t("dashboard:access.sshKeys.generate.done")}
            </Button>
          </div>
        ) : open ? (
          <GenerateKeyForm
            onCancel={close}
            onSubmit={async (name) => {
              const key = await generate.mutateAsync({ name }).catch(() => null);
              if (!key) return;
              invalidate();
              setCreated(key);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GenerateKeyForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { name: "" },
    validators: { onSubmit: z.object({ name: nameSchema(t) }) },
    onSubmit: async ({ value }) => onSubmit(value.name.trim()),
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
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("dashboard:access.sshKeys.form.name")}
            description={t("dashboard:access.sshKeys.form.nameHint")}
            placeholder={t("dashboard:access.sshKeys.form.namePlaceholder")}
            inputMode="text"
            autoComplete="off"
            maxLength={NAME_MAX}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <FormActions
            onCancel={onCancel}
            isSubmitting={isSubmitting}
            submitLabel={t("dashboard:access.sshKeys.generate.submit")}
            pendingLabel={t("dashboard:access.sshKeys.generate.pending")}
          />
        )}
      </form.Subscribe>
    </form>
  );
}

/**
 * Create → Dialog: paste an OpenSSH or PEM private key (and its passphrase,
 * if it has one). The server decrypts it, re-encrypts it under Cockpit Context's key
 * and keeps only that; the form is dropped on close.
 */
export function ImportKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateKeys();
  const importKey = useMutation({
    ...orpc.sshKeys.import.mutationOptions(),
    // The request carries the private key: keep it out of the mutation cache.
    gcTime: 0,
    meta: { errorFallbackKey: "dashboard:access.sshKeys.import.failed" },
  });
  // The dialog stays mounted, so gcTime alone never drops the variables
  // (private key, passphrase): reset the mutation on every way out.
  const close = () => {
    if (importKey.isPending) return;
    importKey.reset();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent closeLabel={t("common:actions.close")} className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{t("dashboard:access.sshKeys.import.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:access.sshKeys.import.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ImportKeyForm
            onCancel={close}
            onSubmit={async (input) => {
              const key = await importKey.mutateAsync(input).catch(() => null);
              if (!key) return;
              importKey.reset();
              invalidate();
              toast.success(t("dashboard:access.sshKeys.import.success", { name: key.name }));
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportKeyForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { name: string; privateKey: string; passphrase?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { name: "", privateKey: "", passphrase: "" },
    validators: {
      onSubmit: z.object({
        name: nameSchema(t),
        privateKey: z
          .string()
          .trim()
          .min(1, t("dashboard:access.sshKeys.form.privateKeyRequired"))
          .max(PRIVATE_KEY_MAX, t("dashboard:access.sshKeys.form.privateKeyTooLong")),
        passphrase: z
          .string()
          .refine(
            (value) => !/[\r\n\0]/.test(value),
            t("dashboard:access.sshKeys.form.passphraseLineBreak"),
          )
          .refine(
            (value) => utf8.encode(value).length <= PASSPHRASE_MAX_BYTES,
            t("dashboard:access.sshKeys.form.passphraseTooLong"),
          ),
      }),
    },
    onSubmit: async ({ value }) =>
      onSubmit({
        name: value.name.trim(),
        privateKey: value.privateKey.trim(),
        passphrase: value.passphrase === "" ? undefined : value.passphrase,
      }),
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
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("dashboard:access.sshKeys.form.name")}
            placeholder={t("dashboard:access.sshKeys.form.namePlaceholder")}
            inputMode="text"
            autoComplete="off"
            maxLength={NAME_MAX}
          />
        )}
      </form.Field>
      <form.Field name="privateKey">
        {(field) => (
          <TextareaField
            field={field}
            label={t("dashboard:access.sshKeys.form.privateKey")}
            description={t("dashboard:access.sshKeys.form.privateKeyHint")}
            placeholder={t("dashboard:access.sshKeys.form.privateKeyPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            rows={8}
            inputClassName="font-mono text-xs"
          />
        )}
      </form.Field>
      <form.Field name="passphrase">
        {(field) => (
          <TextField
            field={field}
            type="password"
            label={t("dashboard:access.sshKeys.form.passphrase")}
            description={t("dashboard:access.sshKeys.form.passphraseHint")}
            autoComplete="off"
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <FormActions
            onCancel={onCancel}
            isSubmitting={isSubmitting}
            submitLabel={t("dashboard:access.sshKeys.import.submit")}
            pendingLabel={t("dashboard:access.sshKeys.import.pending")}
          />
        )}
      </form.Subscribe>
    </form>
  );
}

function FormActions({
  onCancel,
  isSubmitting,
  submitLabel,
  pendingLabel,
}: {
  onCancel: () => void;
  isSubmitting: boolean;
  submitLabel: string;
  pendingLabel: string;
}) {
  const { t } = useTranslation(["common"]);
  return (
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
        {isSubmitting ? pendingLabel : submitLabel}
      </Button>
    </div>
  );
}

/** View details → Dialog: an existing key's public half. */
export function PublicKeyDialog({
  sshKey,
  onOpenChange,
}: {
  sshKey: SshKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <Dialog open={sshKey !== null} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common:actions.close")} className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle className="break-words">{sshKey?.name}</DialogTitle>
          <DialogDescription>{t("dashboard:access.sshKeys.view.description")}</DialogDescription>
        </DialogHeader>
        {sshKey ? <PublicKeyPanel sshKey={sshKey} /> : null}
        <Button type="button" variant="outline" size="touch" onClick={() => onOpenChange(false)}>
          {t("common:actions.close")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** Delete → AlertDialog with type-to-confirm on the key's name. */
export function DeleteKeyDialog({
  sshKey,
  onOpenChange,
}: {
  sshKey: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateKeys();
  const remove = useMutation({
    ...orpc.sshKeys.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:access.sshKeys.delete.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.sshKeys.delete.failed" },
  });
  return (
    <ConfirmDeleteDialog
      open={sshKey !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:access.sshKeys.delete.title")}
      description={t("dashboard:access.sshKeys.delete.description")}
      confirmToken={sshKey?.name ?? ""}
      typePrompt={t("dashboard:access.sshKeys.delete.typePrompt")}
      copyAriaLabel={t("dashboard:access.sshKeys.delete.copy")}
      inputMode="text"
      isPending={remove.isPending}
      onConfirm={() => {
        if (sshKey) remove.mutate({ id: sshKey.id });
      }}
    />
  );
}
