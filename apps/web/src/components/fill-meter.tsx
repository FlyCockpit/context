import { cn } from "@cockpit-context/ui/lib/utils";

const TONE = {
  default: "bg-primary",
  warning: "bg-amber-500",
  danger: "bg-destructive",
} as const;

/**
 * A thin bar filled to a fraction (0..1) with its label beside it (storage
 * used against the cap). `label` is shown as written and names the meter
 * unless `ariaLabel` does. Ported from ws-model-proxy, plus a tone.
 */
export function FillMeter({
  fraction,
  label,
  ariaLabel,
  tone = "default",
  className,
}: {
  fraction: number;
  label: string;
  ariaLabel?: string;
  tone?: keyof typeof TONE;
  className?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div
        role="meter"
        aria-label={ariaLabel ?? label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-[3px] border bg-muted"
      >
        <span className={cn("block h-full", TONE[tone])} style={{ width: `${percent}%` }} />
      </div>
      <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {label}
      </span>
    </div>
  );
}
