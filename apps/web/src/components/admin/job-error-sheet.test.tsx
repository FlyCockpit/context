import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminJob } from "@/lib/admin";

/**
 * A long stack trace scrolls in a wide sheet's body (docs/ui.md § Form
 * surfaces), wrapped, with Close / Retry pinned below it. The sheet portals
 * its popup, so the test renders the popup's parts through a pass-through
 * Sheet mock.
 */
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@cockpit-context/ui/components/sheet", async () => {
  const pass =
    (slot: string) =>
    ({ children, size }: { children?: React.ReactNode; size?: string }) => (
      <div data-slot={slot} data-size={size}>
        {children}
      </div>
    );
  return {
    Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <>{children}</> : null,
    SheetContent: pass("sheet-content"),
    SheetHeader: pass("sheet-header"),
    SheetTitle: pass("sheet-title"),
    SheetDescription: pass("sheet-description"),
    SheetBody: pass("sheet-body"),
    SheetFooter: pass("sheet-footer"),
  };
});

const { JobErrorSheet } = await import("./job-error-sheet");

const failed = {
  id: "j1",
  type: "storage.prune",
  status: "failed",
  attempts: 3,
  maxAttempts: 3,
  lastError: `Error: boom\n${"    at frame (file.ts:1:1)\n".repeat(200)}`,
} as unknown as AdminJob;

function render(job: AdminJob | null) {
  return renderToStaticMarkup(
    <JobErrorSheet job={job} retrying={false} onOpenChange={() => {}} onRetry={() => {}} />,
  );
}

describe("JobErrorSheet", () => {
  it("puts the whole error, wrapped, in the wide sheet's scrolling body", () => {
    const html = render(failed);
    expect(html).toContain('data-slot="sheet-content" data-size="wide"');
    const body = html.slice(
      html.indexOf('data-slot="sheet-body"'),
      html.indexOf('data-slot="sheet-footer"'),
    );
    expect(body).toContain("Error: boom");
    expect(body).toContain("whitespace-pre-wrap");
    expect(body).not.toContain("max-h-80");
  });

  it("offers Retry only for a failed job", () => {
    expect(render(failed)).toContain("admin:jobs.retry");
    expect(render({ ...failed, status: "succeeded" } as AdminJob)).not.toContain(
      "admin:jobs.retry",
    );
    expect(render(null)).toBe("");
  });
});
