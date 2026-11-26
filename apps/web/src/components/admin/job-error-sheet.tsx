import { Button } from "@cockpit-context/ui/components/button";
import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@cockpit-context/ui/components/sheet";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AdminJob } from "@/lib/admin";

/**
 * A job's last error (operator detail: a stack trace can run long), in a wide
 * side sheet: it scrolls in the sheet body between a fixed header and the
 * Close / Retry bar, never inside a dialog (docs/ui.md § Form surfaces).
 */
export function JobErrorSheet({
  job,
  retrying,
  onOpenChange,
  onRetry,
}: {
  job: AdminJob | null;
  retrying: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: (job: AdminJob) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  return (
    <Sheet open={job !== null} onOpenChange={onOpenChange}>
      <SheetContent size="wide" closeLabel={t("common:actions.close")}>
        <SheetHeader>
          <SheetTitle>{t("admin:jobs.errorTitle")}</SheetTitle>
          <SheetDescription>
            {job
              ? t("admin:jobs.errorDescription", {
                  type: job.type,
                  attempts: job.attempts,
                  max: job.maxAttempts,
                })
              : null}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {job?.lastError ? (
            <CodeSnippet code={job.lastError} copyLabel={t("admin:jobs.copyError")} wrap />
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" size="touch" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          {job?.status === "failed" ? (
            <Button size="touch" disabled={retrying} onClick={() => onRetry(job)}>
              <RotateCcw aria-hidden="true" className="size-4" />
              {retrying ? t("admin:jobs.retrying") : t("admin:jobs.retry")}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
