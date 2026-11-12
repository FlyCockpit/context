import { cn } from "@cockpit-context/ui/lib/utils";

/**
 * A nav item's count (pending proposals on Packages). Decorative: the link or
 * button that holds it carries the count in its accessible name
 * (`nav:badge.pendingProposals`).
 */
export function NavBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      data-nav-badge=""
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-none text-amber-950 tabular-nums",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
