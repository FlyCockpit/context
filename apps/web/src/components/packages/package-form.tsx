import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Checkbox } from "@cockpit-context/ui/components/checkbox";
import { DialogFooter } from "@cockpit-context/ui/components/dialog";
import { AdvancedSection } from "@cockpit-context/ui/components/form-page";
import { SheetBody, SheetFooter } from "@cockpit-context/ui/components/sheet";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { SelectField, TextareaField, TextField } from "@cockpit-context/ui/components/text-field";
import { focusFirstInvalidField } from "@cockpit-context/ui/lib/focus-first-invalid";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Search } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { setServerFieldError } from "@/lib/form-server-error";
import {
  buildPackageFormSchema,
  ECOSYSTEMS,
  type Ecosystem,
  hasRegistry,
  isSshRemote,
  type PackageFormValues,
  packageFieldForReason,
} from "@/lib/packages";
import { errorReason, friendly } from "@/utils/friendly-error";
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
  surface,
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
  /**
   * Where the form sits: a wide sheet (the fields scroll in `SheetBody`, the
   * actions are pinned in `SheetFooter`) or a dialog (sticky `DialogFooter`).
   */
  surface: "sheet" | "dialog";
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const formRef = useRef<HTMLFormElement>(null);
  const Body = surface === "sheet" ? SheetBody : "div";
  const Footer = surface === "sheet" ? SheetFooter : DialogFooter;
  const form = useForm({
    defaultValues: initialValues,
    validators: {
      onChange: buildPackageFormSchema({
        gitUrl: t("dashboard:packages.form.gitUrlInvalid"),
        defaultRef: t("dashboard:packages.form.defaultRefInvalid"),
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
      } catch (error) {
        // The mutation's global error toast already told the user; the form
        // stays open with their input.
        showRefusalAtField(error, formRef.current, (name, message) =>
          setServerFieldError(form, name, message),
        );
      }
    },
  });
  const isSsh = useStore(form.store, (state) => isSshRemote(state.values.gitUrl));
  const keyMode = useStore(form.store, (state) => state.values.keyMode);
  const saveKey = useStore(form.store, (state) => state.values.saveKey);
  const ecosystem = useStore(form.store, (state) => state.values.ecosystem);
  const name = useStore(form.store, (state) => state.values.name.trim());
  const advancedValues = {
    displayName: useStore(form.store, (state) => state.values.displayName.trim()),
    subdirectory: useStore(form.store, (state) => state.values.subdirectory.trim()),
    tagPattern: useStore(form.store, (state) => state.values.tagPattern.trim()),
    defaultRef: useStore(form.store, (state) => state.values.defaultRef.trim()),
    hasNotes: useStore(form.store, (state) => state.values.notes.trim() !== ""),
  };
  const advancedSummary = [
    t("dashboard:packages.form.summary.displayName", {
      value:
        advancedValues.displayName ||
        name ||
        initialValues.name ||
        t("dashboard:packages.form.summary.packageName"),
    }),
    t("dashboard:packages.form.summary.subdirectory", {
      value: advancedValues.subdirectory || t("dashboard:packages.form.summary.repoRoot"),
    }),
    t("dashboard:packages.form.summary.tagPattern", {
      value: advancedValues.tagPattern || t("dashboard:packages.form.summary.auto"),
    }),
    t("dashboard:packages.form.summary.defaultRef", {
      value: advancedValues.defaultRef || t("dashboard:packages.form.summary.remoteDefault"),
    }),
    advancedValues.hasNotes
      ? t("dashboard:packages.form.summary.notesSet")
      : t("dashboard:packages.form.summary.noNotes"),
  ].join(" · ");
  // AdvancedSection lays its children out in two columns from `lg:`.
  const advanced = (
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
      <form.Field name="notes">
        {(field) => (
          <TextareaField
            className="lg:col-span-2"
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
        void form.handleSubmit().then(() => {
          if (!form.state.isValid) focusFirstInvalidField(formRef.current);
        });
      }}
      ref={formRef}
      // In a dialog the body and the sticky footer are siblings of a column:
      // the gap is the space DialogFooter's `-mt-2` expects above it.
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", surface === "dialog" && "gap-4")}
    >
      <Body className="min-w-0 space-y-4">
        {intro}
        {mode === "create" ? (
          <div className="min-w-0 space-y-3">
            <div className="grid min-w-0 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <form.Field name="ecosystem">
                {(field) => (
                  <SelectField
                    field={field}
                    label={t("dashboard:packages.form.ecosystem")}
                    options={ECOSYSTEMS.map((value) => ({
                      value,
                      label: t(`dashboard:packages.ecosystems.${value}`),
                    }))}
                  />
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
        ) : null}
        {isSsh ? (
          <div className="space-y-4">
            {mode !== "edit" && mode !== "snapshot-update" ? (
              <form.Field name="keyMode">
                {(field) => (
                  <SelectField
                    field={field}
                    label={t("dashboard:packages.snapshot.keyChoice")}
                    options={[
                      { value: "saved", label: t("dashboard:packages.snapshot.saved") },
                      { value: "once", label: t("dashboard:packages.snapshot.once") },
                    ]}
                  />
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

        {mode === "snapshot-update" ? null : (
          <AdvancedSection title={t("dashboard:packages.form.advanced")} summary={advancedSummary}>
            {advanced}
          </AdvancedSection>
        )}
      </Body>

      <Footer>
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
        {/* Enabled while invalid: a click lands on the first error, even one
            inside the collapsed Advanced section (focusFirstInvalidField). */}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" size="touch" disabled={isSubmitting}>
              {isSubmitting ? pendingLabel : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </Footer>
    </form>
  );
}

/**
 * A refusal about one field (a bad git URL, a taken name, a wrong passphrase)
 * also shows at that field until the user changes it, and focus moves there.
 * Only when the field is on screen: an error on a hidden field would block
 * the form with nothing to fix. Returns whether it was shown.
 */
export function showRefusalAtField(
  error: unknown,
  root: HTMLElement | null,
  setFieldError: (name: keyof PackageFormValues, message: string) => void,
): boolean {
  const name = packageFieldForReason(errorReason(error));
  if (!name || !root?.querySelector(`[id$="-${name}"]`)) return false;
  setFieldError(name, friendly(error));
  focusFirstInvalidField(root);
  return true;
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
      options={items.map((key) => ({
        value: key.id,
        label: key.name,
        description: <span className="font-mono text-xs">{key.fingerprint}</span>,
      }))}
      description={
        <>
          {t("dashboard:packages.form.sshKeyHint")} {manageLink}
        </>
      }
    />
  );
}
