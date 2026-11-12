import { cn } from "@cockpit-context/ui/lib/utils";
import type { ReactNode } from "react";

export type PillTone = "good" | "busy" | "bad" | "muted" | "info";

const TONE: Record<PillTone, string> = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  busy: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  bad: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

/** A small status label. Never the only signal: the text says the state. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
