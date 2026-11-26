import { SheetContent } from "@cockpit-context/ui/components/sheet";
import { cn } from "@cockpit-context/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * Form surfaces (template `patterns/design-system.md` "Form surfaces"): a
 * dialog holds a confirmation or a short form that fits without inner
 * scrolling; anything longer is a wide side sheet. The sheet keeps its header
 * and its action bar in view and scrolls only the fields between them.
 */

/**
 * Wide right-hand sheet for a long form: full screen on phones, two columns
 * from 1024px. It is portalled outside the app frame, so it keeps clear of the
 * notch and the home indicator itself (the frame's `--safe-area-*` insets).
 */
export function FormSheetContent({
  className,
  style,
  ...props
}: ComponentProps<typeof SheetContent>) {
  return (
    <SheetContent
      data-form-surface="sheet"
      className={cn(
        "data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-3xl",
        "[&>[data-slot=sheet-close]]:top-[calc(var(--safe-area-top)_+_0.25rem)] [&>[data-slot=sheet-close]]:right-(--safe-area-right)",
        className,
      )}
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingRight: "var(--safe-area-right)",
        ...style,
      }}
      {...props}
    />
  );
}

/** The scrolling field area of a form sheet, between the sticky header and action bar. */
export const FORM_SHEET_BODY_CLASS =
  "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain border-t px-4 pt-4 pb-4";

/** The sticky action bar of a form sheet: always visible, primary action last. */
export const FORM_SHEET_FOOTER_CLASS =
  "shrink-0 border-t bg-background p-4 pb-[calc(1rem_+_var(--safe-area-bottom))]";

/**
 * A collapsed group of expert fields with safe defaults. The summary line
 * shows the current values while it is closed, so nothing is hidden.
 */
export function AdvancedSection({
  title,
  summary,
  defaultOpen,
  children,
  className,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      data-advanced-section=""
      className={cn("group min-w-0 rounded-md border", className)}
    >
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{title}</span>
          {summary ? (
            <span className="text-xs text-pretty break-words text-muted-foreground group-open:hidden">
              {summary}
            </span>
          ) : null}
        </span>
      </summary>
      <div className="min-w-0 space-y-4 border-t p-3">{children}</div>
    </details>
  );
}

/**
 * After a submit that failed validation, focus the first invalid control
 * (opening a collapsed Advanced section that holds it), so the error is never
 * only somewhere off screen.
 */
export function focusFirstInvalid(root: HTMLElement | null) {
  // The next frame, after the render that marks the invalid fields.
  requestAnimationFrame(() => {
    const target = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!target) return;
    const details = target.closest("details");
    if (details && !details.open) details.open = true;
    target.focus();
    target.scrollIntoView({ block: "center", behavior: "auto" });
  });
}
