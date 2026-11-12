import { Button } from "@cockpit-context/ui/components/button";
import { CopyField } from "@cockpit-context/ui/components/copy-field";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A secret shown exactly once (ported from ws-model-proxy): a warning, the
 * value in a `CopyField`, any setup snippets, and an explicit "Done" that
 * closes the view. The parent drops the value from state on close, so it
 * never renders again.
 */
export function SecretReveal({
  value,
  copyLabel,
  onDone,
  children,
}: {
  value: string;
  copyLabel: string;
  onDone: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["dashboard", "common", "errors"]);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-secret-reveal>
      <div
        role="status"
        className="flex min-w-0 items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      >
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{t("dashboard:access.secret.title")}</p>
          <p className="text-pretty text-muted-foreground">
            {t("dashboard:access.secret.description")}
          </p>
        </div>
      </div>
      <CopyField
        value={value}
        copyLabel={copyLabel}
        onCopied={() => toast.success(t("common:actions.copied"))}
        onCopyError={() => toast.error(t("errors:couldNotCopy"))}
      />
      {children}
      <Button type="button" size="touch" onClick={onDone}>
        {t("dashboard:access.secret.done")}
      </Button>
    </div>
  );
}
