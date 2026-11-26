import { Switch } from "@cockpit-context/ui/components/switch";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * A setting that is on or off: a `Switch` named by the setting's title, with
 * visible "On" / "Off" text in a 44px label. `reason` says why the switch is
 * disabled and is read with it. See docs/ui.md § Settings that are on or off.
 */
export function SettingSwitchRow({
  title,
  description,
  checked,
  disabled = false,
  updating = false,
  reason,
  onCheckedChange,
  className,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  /** A save is in flight: the switch is disabled and the state reads "Updating…". */
  updating?: boolean;
  reason?: string | null;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation(["common"]);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const reasonId = `${id}-reason`;
  const describedBy = reason ? `${descriptionId} ${reasonId}` : descriptionId;

  return (
    <div
      data-slot="setting-switch"
      data-state={checked ? "on" : "off"}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <p id={titleId} className="font-medium">
          {title}
        </p>
        <p id={descriptionId} className="max-w-prose text-sm text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:items-end">
        {/* The label widens the hit area to 44px; the switch is named by the
            title, and its state is aria-checked. */}
        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 has-[[data-disabled]]:cursor-not-allowed">
          <span
            aria-hidden="true"
            className={cn(
              "min-w-[2.5rem] text-sm font-medium sm:text-right",
              checked ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {updating
              ? t("common:switch.updating")
              : checked
                ? t("common:switch.on")
                : t("common:switch.off")}
          </span>
          <Switch
            checked={checked}
            disabled={disabled || updating}
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            onCheckedChange={onCheckedChange}
          />
        </label>
        {reason ? (
          <p id={reasonId} className="text-xs text-muted-foreground sm:max-w-48 sm:text-right">
            {reason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
