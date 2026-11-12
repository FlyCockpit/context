import { cn } from "@cockpit-context/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Optional decorative icon shown in a tinted tile above the title. */
  icon?: LucideIcon;
  className?: string;
};

export function EmptyState({ title, description, action, icon: Icon, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 py-12 text-center", className)}>
      {Icon ? (
        <span
          aria-hidden="true"
          className="mb-1 grid size-12 place-items-center rounded-xl bg-primary/10 text-primary-text"
        >
          <Icon className="size-6" />
        </span>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <div className="max-w-prose text-sm text-pretty text-muted-foreground">{description}</div>
      ) : null}
      {action}
    </div>
  );
}
