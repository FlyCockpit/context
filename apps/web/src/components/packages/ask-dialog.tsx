import { Button } from "@cockpit-context/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cockpit-context/ui/components/dialog";
import { TextareaField, TextField } from "@cockpit-context/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { SegmentedControl } from "@/components/segmented-control";
import { errorReason, friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/**
 * "Ask": start a web conversation about one package (conversations.create,
 * which spends model tokens). The target is the package's default, a version
 * (`5.2.0`, resolved through tags) or any git ref. Resolution happens before
 * the conversation exists, so its errors (an unknown version with the
 * nearest tags, an unconfirmed SSH host) render here, inline.
 */

export type AskTarget = { kind: "default" } | { kind: "version" | "ref"; value: string };

type AskValues = { text: string; target: "default" | "version" | "ref"; value: string };

const MAX_QUESTION = 20_000;

function buildAskSchema(valueRequired: string) {
  return z
    .object({
      text: z.string().trim().min(1).max(MAX_QUESTION),
      target: z.enum(["default", "version", "ref"]),
      value: z.string().trim().max(250),
    })
    .superRefine((values, ctx) => {
      if (values.target !== "default" && values.value.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["value"], message: valueRequired });
      }
    });
}

export function AskDialog({
  pkg,
  initialTarget,
  open,
  onOpenChange,
  lang,
}: {
  pkg: { id: string; identifier: string; defaultRef: string | null };
  initialTarget: AskTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t("common:actions.close")}
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-x-hidden overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("dashboard:ask.title", { identifier: pkg.identifier })}</DialogTitle>
          <DialogDescription>{t("dashboard:ask.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <AskForm
            pkg={pkg}
            initialTarget={initialTarget}
            lang={lang}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AskForm({
  pkg,
  initialTarget,
  lang,
  onCancel,
}: {
  pkg: { id: string; identifier: string; defaultRef: string | null };
  initialTarget: AskTarget;
  lang: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<unknown>(null);

  const start = useMutation({
    ...orpc.conversations.create.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
        void navigate({
          to: "/$lang/conversations/$conversationId",
          params: { lang, conversationId: result.conversationId },
        });
      },
      onError: (error) => {
        setFailure(error);
        // Resolving may have cloned or fetched before it failed.
        void queryClient.invalidateQueries({ queryKey: orpc.packages.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.repositories.key() });
      },
    }),
    // The failure renders inline (with nearest tags or a host-key link).
    meta: { skipGlobalErrorToast: true },
  });

  const form = useForm({
    defaultValues: {
      text: "",
      target: initialTarget.kind,
      value: initialTarget.kind === "default" ? "" : initialTarget.value,
    } as AskValues,
    validators: { onChange: buildAskSchema(t("dashboard:ask.valueRequired")) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const target = value.value.trim();
      try {
        await start.mutateAsync({
          packageId: pkg.id,
          text: value.text.trim(),
          ...(value.target === "version" ? { version: target } : {}),
          ...(value.target === "ref" ? { ref: target } : {}),
        });
      } catch {
        // Rendered inline from `failure`.
      }
    },
  });
  const target = useStore(form.store, (state) => state.values.target);

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
      <form.Field name="text">
        {(field) => (
          <TextareaField
            field={field}
            label={t("dashboard:ask.question")}
            placeholder={t("dashboard:ask.questionPlaceholder")}
            autoComplete="off"
            rows={5}
            maxLength={MAX_QUESTION}
          />
        )}
      </form.Field>

      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{t("dashboard:ask.target")}</p>
        <form.Field name="target">
          {(field) => (
            <SegmentedControl
              ariaLabel={t("dashboard:ask.target")}
              value={field.state.value}
              onChange={(next) => field.handleChange(next)}
              items={[
                { value: "default", label: t("dashboard:ask.targets.default") },
                { value: "version", label: t("dashboard:ask.targets.version") },
                { value: "ref", label: t("dashboard:ask.targets.ref") },
              ]}
            />
          )}
        </form.Field>
        {target === "default" ? (
          <p className="text-xs text-muted-foreground">
            {pkg.defaultRef
              ? t("dashboard:ask.defaultRef", { ref: pkg.defaultRef })
              : t("dashboard:ask.defaultBranch")}
          </p>
        ) : (
          <form.Field name="value">
            {(field) => (
              <TextField
                field={field}
                label={
                  target === "version"
                    ? t("dashboard:ask.versionLabel")
                    : t("dashboard:ask.refLabel")
                }
                description={
                  target === "version" ? t("dashboard:ask.versionHint") : t("dashboard:ask.refHint")
                }
                placeholder={
                  target === "version"
                    ? t("dashboard:ask.versionPlaceholder")
                    : t("dashboard:ask.refPlaceholder")
                }
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputClassName="font-mono"
              />
            )}
          </form.Field>
        )}
      </div>

      {failure ? (
        <AskFailure
          error={failure}
          lang={lang}
          onPickTag={(tag) => {
            form.setFieldValue("target", "ref");
            form.setFieldValue("value", tag);
            setFailure(null);
          }}
        />
      ) : null}

      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) =>
          isSubmitting ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t("dashboard:ask.resolving")}
            </p>
          ) : null
        }
      </form.Subscribe>

      {/* Before the first message (docs/product.md). */}
      <p className="text-xs text-muted-foreground">{t("dashboard:ask.aiDisclosure")}</p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
              {isSubmitting ? t("dashboard:ask.pending") : t("dashboard:ask.submit")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function nearestTags(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const data = (error as { data?: { nearestTags?: unknown } }).data;
  const tags = data?.nearestTags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/** The host a HOST_KEY_UNCONFIRMED error names, so Known hosts can open its scan prefilled. */
function unconfirmedHost(error: unknown): { host?: string; port?: number } {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: { host?: unknown; port?: unknown } }).data;
  if (typeof data?.host !== "string") return {};
  return typeof data.port === "number" ? { host: data.host, port: data.port } : { host: data.host };
}

function AskFailure({
  error,
  lang,
  onPickTag,
}: {
  error: unknown;
  lang: string;
  onPickTag: (tag: string) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const reason = errorReason(error);
  const tags = nearestTags(error);
  return (
    <div
      role="alert"
      className="min-w-0 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <p className="font-medium text-destructive">{friendly(error, t("dashboard:ask.failed"))}</p>
      {tags.length > 0 ? (
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-muted-foreground">{t("dashboard:ask.nearestTags")}</p>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Button
                key={tag}
                type="button"
                variant="outline"
                size="touch"
                className="max-w-full font-mono"
                onClick={() => onPickTag(tag)}
              >
                <span className="truncate">{tag}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {reason === "HOST_KEY_UNCONFIRMED" ? (
        <Link
          to="/$lang/access/known-hosts"
          params={{ lang }}
          search={unconfirmedHost(error)}
          className="inline-flex min-h-[44px] items-center font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("dashboard:ask.confirmHost")}
        </Link>
      ) : null}
    </div>
  );
}
