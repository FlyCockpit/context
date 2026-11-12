import { Checkbox } from "@cockpit-context/ui/components/checkbox";
import { Label } from "@cockpit-context/ui/components/label";
import { Switch } from "@cockpit-context/ui/components/switch";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { type ConnectionFlags, normalizeFlags } from "@/lib/access";

/**
 * The two per-connection flags (docs/mcp.md): "may propose packages"
 * and "auto-approve its proposals". Auto-approve is off and disabled while
 * proposing is off; the server applies the same rule.
 *
 * - `variant="form"`: checkboxes with a short explanation each, for the
 *   create-token dialog and the consent page.
 * - `variant="row"`: compact switches for a list row; each change is saved
 *   at once by the caller.
 */
export function FlagSwitches({
  value,
  onChange,
  disabled = false,
  variant,
  className,
}: {
  value: ConnectionFlags;
  onChange: (next: ConnectionFlags) => void;
  disabled?: boolean;
  variant: "form" | "row";
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const baseId = useId();
  const flags = normalizeFlags(value);
  const rows = [
    {
      key: "allowPropose" as const,
      checked: flags.allowPropose,
      disabled,
      label: t("dashboard:access.flags.allowPropose"),
      short: t("dashboard:access.flags.allowProposeShort"),
      hint: t("dashboard:access.flags.allowProposeHint"),
      set: (checked: boolean) => onChange(normalizeFlags({ ...flags, allowPropose: checked })),
    },
    {
      key: "autoApprove" as const,
      checked: flags.autoApprove,
      disabled: disabled || !flags.allowPropose,
      label: t("dashboard:access.flags.autoApprove"),
      short: t("dashboard:access.flags.autoApproveShort"),
      hint: t("dashboard:access.flags.autoApproveHint"),
      set: (checked: boolean) => onChange(normalizeFlags({ ...flags, autoApprove: checked })),
    },
  ];

  if (variant === "row") {
    return (
      <div className={cn("flex min-w-0 flex-wrap gap-x-5 gap-y-1", className)}>
        {rows.map((row) => {
          const id = `${baseId}-${row.key}`;
          return (
            <div key={row.key} className="flex min-h-[44px] items-center gap-2">
              <Switch
                id={id}
                checked={row.checked}
                disabled={row.disabled}
                onCheckedChange={(checked) => row.set(checked)}
              />
              <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
                {row.short}
              </Label>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <fieldset className={cn("min-w-0 space-y-1", className)}>
      <legend className="sr-only">{t("dashboard:access.flags.legend")}</legend>
      {rows.map((row) => {
        const id = `${baseId}-${row.key}`;
        const hintId = `${id}-hint`;
        return (
          <div key={row.key} className="flex min-h-[44px] items-start gap-3 py-1.5">
            <Checkbox
              id={id}
              checked={row.checked}
              disabled={row.disabled}
              aria-describedby={hintId}
              onCheckedChange={(checked) => row.set(checked === true)}
              className="mt-0.5"
            />
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor={id} className={cn(row.disabled && "opacity-60")}>
                {row.label}
              </Label>
              <p id={hintId} className="text-xs text-pretty text-muted-foreground">
                {row.hint}
              </p>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
