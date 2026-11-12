import { SelectorRow } from "@cockpit-context/ui/components/selector-row";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Fragment, type ReactNode } from "react";

const WIDTH_CLASS = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

type PageShellProps = {
  width?: keyof typeof WIDTH_CLASS;
  className?: string;
  children: ReactNode;
};

export function PageShell({ width = "default", className, children }: PageShellProps) {
  return (
    <div className={cn("container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[width], className)}>
      {children}
    </div>
  );
}

/**
 * The quiet "← Parent" link above a child page's heading (package detail,
 * proposals, a conversation, admin sub-pages). A class rather than a component
 * because each call site passes its own typed `<Link to>`.
 */
export const BACK_LINK_CLASS =
  "-ms-2 inline-flex min-h-[44px] w-fit items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      {actions}
    </div>
  );
}

export type SectionTab = {
  key: string;
  label: string;
  /** Renders the tab's link (typed by the caller's route) with the shared classes. */
  render: (className: string, activeClassName: string, children: ReactNode) => ReactNode;
};

const SECTION_TAB_CLASS =
  "inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium not-data-[status=active]:text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SECTION_TAB_ACTIVE_CLASS = "bg-muted text-foreground";

/**
 * Brings the active tab into the row's view when the row mounts: on a phone a
 * later tab (Access → Known hosts) otherwise starts off-screen, so nothing
 * shows where you are. Later changes come from tapping a tab already in view.
 * A ref callback, not an effect, and it only moves the row's own scroll.
 */
function revealActiveTab(row: HTMLDivElement | null) {
  const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!row || !active) return;
  const rowBox = row.getBoundingClientRect();
  const tabBox = active.getBoundingClientRect();
  if (tabBox.right > rowBox.right) row.scrollLeft += tabBox.right - rowBox.right + 16;
  else if (tabBox.left < rowBox.left) row.scrollLeft -= rowBox.left - tabBox.left + 16;
}

/**
 * A row of links to a section's sub-pages (Access: tokens, connections, …;
 * Settings: profile, security). Scrolls sideways inside its own `SelectorRow`
 * on phones, never the page.
 */
export function SectionTabs({
  tabs,
  ariaLabel,
}: {
  tabs: readonly SectionTab[];
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className="-mx-4 min-w-0 border-b px-4 sm:mx-0 sm:px-0">
      <SelectorRow ref={revealActiveTab} innerClassName="gap-1 pb-2">
        {tabs.map((tab) => (
          <Fragment key={tab.key}>
            {tab.render(SECTION_TAB_CLASS, SECTION_TAB_ACTIVE_CLASS, tab.label)}
          </Fragment>
        ))}
      </SelectorRow>
    </nav>
  );
}
