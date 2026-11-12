import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Checkbox } from "@cockpit-context/ui/components/checkbox";
import { SelectItem } from "@cockpit-context/ui/components/select";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { SelectField, TextareaField, TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  buildPackageFormSchema,
  ECOSYSTEMS,
  type Ecosystem,
  hasRegistry,
  isSshRemote,
  type PackageFormValues,
} from "@/lib/packages";
import { orpc } from "@/utils/orpc";

/**
 * The one package form: create (ecosystem and name editable, registry
 * lookup), approve (a proposal's suggestions, identifier fixed) and edit
 * (identifier fixed, every setting shown). The caller owns the mutation and
 * the overlay; this owns the fields, validation and the registry lookup.
 */

export type PackageFormMode = "create" | "approve" | "edit" | "snapshot-update";

type FieldLike = {
  name: string;
  state: { value: string; meta: { errors: readonly unknown[] } };
  handleBlur: () => void;
  handleChange: (value: string) => void;
};

/** One page of keys: a picker, not a list screen (nobody keeps 100 deploy keys). */
const SSH_KEY_PICKER_LIMIT = 100;

export function PackageForm({
  mode,
  lang,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel,
  pendingLabel,
  intro,
  bodyClassName,
  footerClassName,
}: {
  mode: PackageFormMode;
  lang: string;
  initialValues: PackageFormValues;
  onSubmit: (values: PackageFormValues) => Promise<unknown>;
  onCancel: () => void;
  submitLabel: string;
  pendingLabel: string;
  /** Shown above the fields (the proposal's reason when approving). */
  intro?: ReactNode;
  bodyClassName?: string;
  footerClassName?: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: initialValues,
    validators: {
      onChange: buildPackageFormSchema({
        sshKeyRequired: t("dashboard:packages.form.sshKeyRequired"),
        privateKeyRequired: t("dashboard:access.sshKeys.form.privateKeyRequired"),
        keyNameRequired: t("dashboard:access.sshKeys.form.nameRequired"),
        subdirectory: t("dashboard:packages.form.subdirectoryInvalid"),
        tagPattern: t("dashboard:packages.form.tagPatternInvalid"),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await onSubmit(value);
      } catch {
        // The mutation's global error toast already told the user; the form
        // stays open with their input.
      }
    },
  });
  const isSsh = useStore(form.store, (state) => isSshRemote(state.values.gitUrl));
  const keyMode = useStore(form.store, (state) => state.values.keyMode);
  const saveKey = useStore(form.store, (state) => state.values.saveKey);
  const ecosystem = useStore(form.store, (state) => state.values.ecosystem);
  const name = useStore(form.store, (state) => state.values.name.trim());
  const ecosystemLabels = Object.fromEntries(
    ECOSYSTEMS.map((value) => [value, t(`dashboard:packages.ecosystems.${value}`)]),
  );
  const advancedSet = [
    initialValues.subdirectory,
    initialValues.tagPattern,
    initialValues.defaultRef,
    initialValues.notes,
  ].some((value) => value.trim() !== "");

  const advanced = (
    <>
      <form.Field name="subdirectory">
        {(field) => (
          <TextField
            field={field}
            label={t("dashboard:packages.form.subdirectory")}
            description={t("dashboard:packages.form.subdirectoryHint")}
            placeholder={t("dashboard:packages.form.placeholders.subdirectory")}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            inputClassName="font-mono"
          />
        )}
      </form.Field>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <form.Field name="tagPattern">
          {(field) => (
            <TextField
              field={field}
              label={t("dashboard:packages.form.tagPattern")}
              description={t("dashboard:packages.form.tagPatternHint")}
              placeholder={t("dashboard:packages.form.placeholders.tagPattern")}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              inputClassName="font-mono"
            />
          )}
        </form.Field>
        <form.Field name="defaultRef">
          {(field) => (
            <TextField
              field={field}
              label={t("dashboard:packages.form.defaultRef")}
              description={t("dashboard:packages.form.defaultRefHint")}
              placeholder={t("dashboard:packages.form.placeholders.defaultRef")}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              inputClassName="font-mono"
            />
          )}
        </form.Field>
      </div>
      <form.Field name="notes">
        {(field) => (
          <TextareaField
            field={field}
            label={t("dashboard:packages.form.notes")}
            description={t("dashboard:packages.form.notesHint")}
            autoComplete="off"
            rows={4}
            maxLength={10_000}
          />
        )}
      </form.Field>
    </>
  );

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className={cn("min-w-0 space-y-4", bodyClassName)}>
        {intro}
        {mode === "create" ? (
          <div className="min-w-0 space-y-3">
            <div className="grid min-w-0 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <form.Field name="ecosystem">
                {(field) => (
                  <SelectField
                    field={field}
                    label={t("dashboard:packages.form.ecosystem")}
                    items={ecosystemLabels}
                  >
                    {ECOSYSTEMS.map((value) => (
                      <SelectItem key={value} value={value} className="min-h-[44px]">
                        {ecosystemLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectField>
                )}
              </form.Field>
              <form.Field name="name">
                {(field) => (
                  <TextField
                    field={field}
                    label={t("dashboard:packages.form.name")}
                    placeholder={t(`dashboard:packages.form.namePlaceholders.${ecosystem}`)}
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    inputClassName="font-mono"
                  />
                )}
              </form.Field>
            </div>
            {/* Remounted when the name changes, so a stale result never shows. */}
            <RegistryLookup
              key={`${ecosystem}:${name}`}
              ecosystem={ecosystem}
              name={name}
              onFound={(suggestion, overwrite) => {
                const values = form.state.values;
                const apply = (key: "gitUrl" | "displayName" | "subdirectory", next: string) => {
                  if (overwrite || values[key].trim() === "") form.setFieldValue(key, next);
                };
                if (suggestion.gitUrl) apply("gitUrl", suggestion.gitUrl);
                if (suggestion.displayName) apply("displayName", suggestion.displayName);
                if (overwrite || suggestion.subdirectory) {
                  apply("subdirectory", suggestion.subdirectory ?? "");
                }
              }}
            />
          </div>
        ) : (
          <FixedIdentity ecosystem={initialValues.ecosystem} name={initialValues.name} />
        )}

        {mode !== "snapshot-update" ? (
          <>
            <form.Field name="displayName">
              {(field) => (
                <TextField
                  field={field}
                  label={t("dashboard:packages.form.displayName")}
                  description={t("dashboard:packages.form.displayNameHint")}
                  inputMode="text"
                  autoComplete="off"
                />
              )}
            </form.Field>

            <form.Field name="gitUrl">
              {(field) => (
                <TextField
                  field={field}
                  label={t("dashboard:packages.form.gitUrl")}
                  description={t("dashboard:packages.form.gitUrlHint")}
                  placeholder={t("dashboard:packages.form.placeholders.gitUrl")}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  inputClassName="font-mono"
                />
              )}
            </form.Field>
          </>
        ) : null}
        {isSsh ? (
          <div className="space-y-4">
            {mode !== "edit" && mode !== "snapshot-update" ? (
              <form.Field name="keyMode">
                {(field) => (
                  <SelectField
                    field={field}
                    label={t("dashboard:packages.snapshot.keyChoice")}
                    items={{
                      saved: t("dashboard:packages.snapshot.saved"),
                      once: t("dashboard:packages.snapshot.once"),
                    }}
                  >
                    <SelectItem value="saved" className="min-h-[44px]">
                      {t("dashboard:packages.snapshot.saved")}
                    </SelectItem>
                    <SelectItem value="once" className="min-h-[44px]">
                      {t("dashboard:packages.snapshot.once")}
                    </SelectItem>
                  </SelectField>
                )}
              </form.Field>
            ) : null}
            {keyMode === "once" ? (
              <>
                {mode !== "snapshot-update" ? (
                  <p className="text-sm text-muted-foreground">
                    {t("dashboard:packages.snapshot.hint")}
                  </p>
                ) : null}
                <form.Field name="privateKey">
                  {(field) => (
                    <TextareaField
                      field={field}
                      label={t("dashboard:access.sshKeys.form.privateKey")}
                      autoComplete="off"
                      spellCheck={false}
                      rows={6}
                      maxLength={16_384}
                    />
                  )}
                </form.Field>
                <form.Field name="passphrase">
                  {(field) => (
                    <TextField
                      field={field}
                      label={t("dashboard:access.sshKeys.form.passphrase")}
                      type="password"
                      autoComplete="off"
                      maxLength={4096}
                    />
                  )}
                </form.Field>
                <form.Field name="saveKey">
                  {(field) => (
                    <label className="flex min-h-[44px] items-center gap-3 text-sm">
                      <Checkbox
                        checked={field.state.value}
                        onCheckedChange={(checked) => field.handleChange(checked === true)}
                      />
                      {t("dashboard:packages.snapshot.save")}
                    </label>
                  )}
                </form.Field>
                {saveKey ? (
                  <form.Field name="keyName">
                    {(field) => (
                      <TextField
                        field={field}
                        label={t("dashboard:access.sshKeys.form.name")}
                        inputMode="text"
                        autoComplete="off"
                        maxLength={100}
                      />
                    )}
                  </form.Field>
                ) : null}
              </>
            ) : (
              <form.Field name="sshKeyId">
                {(field) => <SshKeyPicker field={field} lang={lang} />}
              </form.Field>
            )}
          </div>
        ) : null}

        {mode === "snapshot-update" ? null : mode === "edit" ? (
          advanced
        ) : (
          <details open={advancedSet} className="group min-w-0 rounded-md border">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              {t("dashboard:packages.form.moreOptions")}
            </summary>
            <div className="min-w-0 space-y-4 border-t p-3">{advanced}</div>
          </details>
        )}
      </div>

      <div
        className={cn(
          "flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end",
          footerClassName,
        )}
      >
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
              {isSubmitting ? pendingLabel : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

type LookupSuggestion = {
  gitUrl: string | null;
  displayName: string | null;
  subdirectory: string | null;
};

/** The registry lookup button and its result: fills empty fields, or all of them on request. */
function RegistryLookup({
  ecosystem,
  name,
  onFound,
}: {
  ecosystem: Ecosystem;
  name: string;
  onFound: (suggestion: LookupSuggestion, overwrite: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const lookup = useMutation({
    ...orpc.packages.lookupRegistry.mutationOptions({
      onSuccess: (result) => {
        if (result.status === "found") onFound(result, false);
      },
    }),
    meta: { errorFallbackKey: "dashboard:packages.lookup.failed" },
  });

  if (!hasRegistry(ecosystem)) {
    return (
      <p className="text-xs text-muted-foreground">{t("dashboard:packages.lookup.gitHint")}</p>
    );
  }
  const registry = t(`dashboard:packages.registries.${ecosystem}`);
  const result = lookup.data;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="self-start"
        disabled={name === "" || lookup.isPending}
        onClick={() => lookup.mutate({ ecosystem, name })}
      >
        <Search aria-hidden="true" className="size-4" />
        {lookup.isPending
          ? t("dashboard:packages.lookup.pending")
          : t("dashboard:packages.lookup.action", { registry })}
      </Button>
      <div aria-live="polite" className="min-w-0">
        {result ? (
          <LookupResult result={result} registry={registry} onUseAll={(r) => onFound(r, true)} />
        ) : null}
      </div>
    </div>
  );
}

type LookupResponse = Awaited<ReturnType<AppRouterClient["packages"]["lookupRegistry"]>>;

function LookupResult({
  result,
  registry,
  onUseAll,
}: {
  result: LookupResponse;
  registry: string;
  onUseAll: (suggestion: LookupSuggestion) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (result.status !== "found") {
    return (
      <p className="text-sm text-muted-foreground">
        {result.status === "not_found"
          ? t("dashboard:packages.lookup.notFound", { registry })
          : t("dashboard:packages.lookup.unavailable", { registry })}
      </p>
    );
  }
  return (
    <div className="min-w-0 space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("dashboard:packages.lookup.found", { registry })}</p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {result.latestVersion ? (
          <>
            <dt className="text-muted-foreground">
              {t("dashboard:packages.lookup.latestVersion")}
            </dt>
            <dd className="truncate font-mono">{result.latestVersion}</dd>
          </>
        ) : null}
        {result.gitUrl ? (
          <>
            <dt className="text-muted-foreground">{t("dashboard:packages.form.gitUrl")}</dt>
            <dd className="truncate font-mono">{result.gitUrl}</dd>
          </>
        ) : null}
        {result.subdirectory ? (
          <>
            <dt className="text-muted-foreground">{t("dashboard:packages.form.subdirectory")}</dt>
            <dd className="truncate font-mono">{result.subdirectory}</dd>
          </>
        ) : null}
      </dl>
      {result.gitUrl ? null : (
        <p className="text-xs text-muted-foreground">
          {t("dashboard:packages.lookup.noRepository")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="touch" onClick={() => onUseAll(result)}>
          {t("dashboard:packages.lookup.useAll")}
        </Button>
        {result.homepage ? (
          <a
            href={result.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "gap-1")}
          >
            {t("dashboard:packages.lookup.homepage")}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Ecosystem and name never change after creation; shown, not edited. */
function FixedIdentity({ ecosystem, name }: { ecosystem: Ecosystem; name: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium">{t("dashboard:packages.form.identifier")}</p>
      <p className="truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
        {ecosystem}:{name}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("dashboard:packages.form.identifierFixed")}
      </p>
    </div>
  );
}

/** Mounted only while the git URL is an SSH remote, so the key list loads only then. */
function SshKeyPicker({ field, lang }: { field: FieldLike; lang: string }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const keys = useQuery(orpc.sshKeys.list.queryOptions({ input: { limit: SSH_KEY_PICKER_LIMIT } }));
  const items = keys.data?.items ?? [];
  const manageLink = (
    <Link
      to="/$lang/access/ssh-keys"
      params={{ lang }}
      className="font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t("dashboard:packages.form.manageKeys")}
    </Link>
  );

  if (keys.isPending) {
    return (
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{t("dashboard:packages.form.sshKey")}</p>
        <Skeleton className="h-11 w-full md:h-8" />
      </div>
    );
  }
  if (keys.isError) {
    return (
      <div className="min-w-0 space-y-2 text-sm">
        <p className="font-medium">{t("dashboard:packages.form.sshKey")}</p>
        <p className="text-destructive">{t("dashboard:packages.form.sshKeysFailed")}</p>
        <Button type="button" variant="outline" size="touch" onClick={() => keys.refetch()}>
          {t("common:actions.tryAgain")}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="min-w-0 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <p className="font-medium">{t("dashboard:packages.form.noSshKeys")}</p>
        <p className="text-muted-foreground">
          {t("dashboard:packages.form.noSshKeysBody")} {manageLink}
        </p>
      </div>
    );
  }
  return (
    <SelectField
      field={field}
      label={t("dashboard:packages.form.sshKey")}
      placeholder={t("dashboard:packages.form.sshKeyPlaceholder")}
      items={Object.fromEntries(items.map((key) => [key.id, key.name]))}
      description={
        <>
          {t("dashboard:packages.form.sshKeyHint")} {manageLink}
        </>
      }
    >
      {items.map((key) => (
        <SelectItem key={key.id} value={key.id} className="min-h-[44px]">
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{key.name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {key.fingerprint}
            </span>
          </span>
        </SelectItem>
      ))}
    </SelectField>
  );
}
