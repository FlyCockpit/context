import { Button } from "@cockpit-context/ui/components/button";
import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import { CopyField } from "@cockpit-context/ui/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { Label } from "@cockpit-context/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@cockpit-context/ui/components/sheet";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FlagSwitches } from "@/components/access/flag-switches";
import { SecretReveal } from "@/components/access/secret-reveal";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { useHomeStatus } from "@/hooks/use-home-status";
import {
  claudeTokenCommand,
  codexTokenCommand,
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiryFromChoice,
  type McpToken,
  mcpJsonConfig,
  normalizeFlags,
} from "@/lib/access";
import { orpc } from "@/utils/orpc";

/** Matches the server's `shortText` cap. */
const NAME_MAX = 120;

const DIALOG_CLASS =
  "flex max-h-[calc(100dvh-2rem)] flex-col overflow-x-hidden overflow-y-auto sm:max-w-lg";

/**
 * Create → Dialog (docs/development.md): the form, then the token exactly
 * once with ready-to-paste agent config. The mutation lives here so the
 * dialog cannot close while a token is being minted (a late answer would
 * reveal the secret after the dialog was dismissed), and `gcTime: 0` keeps
 * the response, which carries the plaintext, out of the mutation cache.
 */
export function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    ...orpc.mcpTokens.create.mutationOptions(),
    gcTime: 0,
    meta: { errorFallbackKey: "dashboard:access.tokens.create.failed" },
  });
  const close = () => {
    if (create.isPending) return;
    setSecret(null);
    create.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent closeLabel={t("common:actions.close")} className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>
            {secret
              ? t("dashboard:access.tokens.created.title")
              : t("dashboard:access.tokens.create.title")}
          </DialogTitle>
          <DialogDescription>
            {secret
              ? t("dashboard:access.tokens.created.description")
              : t("dashboard:access.tokens.create.description")}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <TokenSetup secret={secret} onDone={close} />
        ) : open ? (
          <CreateTokenForm
            onCancel={close}
            onSubmit={async (input) => {
              const result = await create.mutateAsync(input).catch(() => null);
              if (!result) return;
              // Reveal at once, then drop the response from the mutation.
              setSecret(result.secret);
              create.reset();
              void queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() });
              void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type CreateInput = {
  name: string;
  expiresAt: Date | null;
  allowPropose: boolean;
  autoApprove: boolean;
};

function CreateTokenForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: CreateInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: {
      name: "",
      expiry: DEFAULT_EXPIRY as ExpiryChoice,
      allowPropose: true,
      autoApprove: false,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t("dashboard:access.tokens.form.nameRequired"))
          .max(NAME_MAX, t("dashboard:access.tokens.form.nameTooLong", { max: NAME_MAX })),
        expiry: z.enum(EXPIRY_CHOICES),
        allowPropose: z.boolean(),
        autoApprove: z.boolean(),
      }),
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        name: value.name.trim(),
        expiresAt: expiryFromChoice(value.expiry, Date.now()),
        ...normalizeFlags(value),
      });
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
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("dashboard:access.tokens.form.name")}
            description={t("dashboard:access.tokens.form.nameHint")}
            placeholder={t("dashboard:access.tokens.form.namePlaceholder")}
            inputMode="text"
            autoComplete="off"
            maxLength={NAME_MAX}
          />
        )}
      </form.Field>
      <form.Field name="expiry">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("dashboard:access.tokens.form.expiry")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("dashboard:access.tokens.form.expiry")}
              items={EXPIRY_CHOICES.map((choice) => ({
                value: choice,
                label: t(`dashboard:access.expiry.${choice}`),
              }))}
            />
          </div>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({
          allowPropose: state.values.allowPropose,
          autoApprove: state.values.autoApprove,
        })}
      >
        {(flags) => (
          <FlagSwitches
            variant="form"
            value={flags}
            onChange={(next) => {
              form.setFieldValue("allowPropose", next.allowPropose);
              form.setFieldValue("autoApprove", next.autoApprove);
            }}
          />
        )}
      </form.Subscribe>
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
                ? t("dashboard:access.tokens.create.pending")
                : t("dashboard:access.tokens.create.submit")}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/** The one-time token plus the Claude Code command and the generic JSON block. */
function TokenSetup({ secret, onDone }: { secret: string; onDone: () => void }) {
  const { t } = useTranslation(["dashboard", "common", "errors"]);
  const status = useHomeStatus();
  const mcpUrl = status.data?.mcpUrl ?? null;
  const onCopied = () => toast.success(t("common:actions.copied"));
  const onCopyError = () => toast.error(t("errors:couldNotCopy"));
  return (
    <SecretReveal
      value={secret}
      copyLabel={t("dashboard:access.tokens.created.copyToken")}
      onDone={onDone}
    >
      {mcpUrl ? (
        <>
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("dashboard:access.tokens.created.claudeCode")}</p>
            <CopyField
              value={claudeTokenCommand(mcpUrl, secret)}
              copyLabel={t("dashboard:access.tokens.created.copyCommand")}
              onCopied={onCopied}
              onCopyError={onCopyError}
            />
            <p className="text-xs text-pretty text-muted-foreground">
              {t("dashboard:access.tokens.created.claudeCodeHint")}
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("dashboard:access.tokens.created.codex")}</p>
            <CodeSnippet
              code={codexTokenCommand(mcpUrl, secret)}
              copyLabel={t("dashboard:access.tokens.created.copyCodex")}
              onCopied={onCopied}
              onCopyError={onCopyError}
            />
            <p className="text-xs text-pretty text-muted-foreground">
              {t("dashboard:access.tokens.created.codexHint")}
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("dashboard:access.tokens.created.json")}</p>
            <CodeSnippet
              code={mcpJsonConfig(mcpUrl, secret)}
              copyLabel={t("dashboard:access.tokens.created.copyJson")}
              onCopied={onCopied}
              onCopyError={onCopyError}
            />
          </div>
        </>
      ) : status.isError ? (
        // The token is still shown above; only the snippets need the address.
        <InlineRetry
          variant="destructive"
          message={t("dashboard:access.mcpUrlFailed")}
          onRetry={() => void status.refetch()}
        />
      ) : (
        <Skeleton className="h-11 w-full" />
      )}
    </SecretReveal>
  );
}

/** Edit → Sheet: the token's name (flags are switched in the row). */
export function RenameTokenSheet({
  token,
  onOpenChange,
}: {
  token: McpToken | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.mcpTokens.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() });
        toast.success(t("dashboard:access.tokens.rename.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.tokens.rename.failed" },
  });
  return (
    <Sheet
      open={token !== null}
      onOpenChange={(next) => (update.isPending ? null : onOpenChange(next))}
    >
      <SheetContent
        closeLabel={t("common:actions.close")}
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{t("dashboard:access.tokens.rename.title")}</SheetTitle>
          <SheetDescription>{t("dashboard:access.tokens.rename.description")}</SheetDescription>
        </SheetHeader>
        {token ? (
          <RenameForm
            key={token.id}
            initialName={token.name}
            onCancel={() => onOpenChange(false)}
            onSubmit={async (name) => {
              if (name === token.name) {
                onOpenChange(false);
                return;
              }
              await update.mutateAsync({ id: token.id, name }).catch(() => null);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function RenameForm({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { name: initialName },
    validators: {
      onChange: z.object({
        name: z
          .string()
          .trim()
          .min(1, t("dashboard:access.tokens.form.nameRequired"))
          .max(NAME_MAX, t("dashboard:access.tokens.form.nameTooLong", { max: NAME_MAX })),
      }),
    },
    onSubmit: async ({ value }) => onSubmit(value.name.trim()),
  });
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-2">
        <form.Field name="name">
          {(field) => (
            <TextField
              field={field}
              label={t("dashboard:access.tokens.form.name")}
              inputMode="text"
              autoComplete="off"
              maxLength={NAME_MAX}
            />
          )}
        </form.Field>
      </div>
      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="flex flex-col-reverse gap-2 border-t p-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/** Revoke → AlertDialog with type-to-confirm on the token's name. */
export function RevokeTokenDialog({
  token,
  onOpenChange,
}: {
  token: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    ...orpc.mcpTokens.revoke.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
        toast.success(t("dashboard:access.tokens.revoke.success"));
        onOpenChange(false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:access.tokens.revoke.failed" },
  });
  return (
    <ConfirmDeleteDialog
      open={token !== null}
      onOpenChange={onOpenChange}
      title={t("dashboard:access.tokens.revoke.title")}
      description={t("dashboard:access.tokens.revoke.description")}
      confirmToken={token?.name ?? ""}
      typePrompt={t("dashboard:access.tokens.revoke.typePrompt")}
      copyAriaLabel={t("dashboard:access.tokens.revoke.copy")}
      inputMode="text"
      confirmLabel={t("dashboard:access.revoke")}
      pendingLabel={t("dashboard:access.revoking")}
      isPending={revoke.isPending}
      onConfirm={() => {
        if (token) revoke.mutate({ id: token.id });
      }}
    />
  );
}
