import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useHomeStatus } from "@/hooks/use-home-status";

/**
 * The pending-proposals band: agents asked for packages and are waiting on
 * you. On Packages and on the Ongoing home, so a blocked agent is seen
 * without opening the menu. Renders nothing while there is nothing to review.
 */
export function PendingProposalsBanner({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const pending = useHomeStatus().data?.pendingProposals ?? 0;
  if (pending === 0) return null;
  return (
    <div
      role="status"
      data-slot="pending-proposals"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Inbox
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            {t("dashboard:packages.pendingBanner.title", { count: pending })}
          </p>
          <p className="text-sm text-pretty text-muted-foreground">
            {t("dashboard:packages.pendingBanner.body", { count: pending })}
          </p>
        </div>
      </div>
      <Link
        to="/$lang/packages/proposals"
        params={{ lang }}
        className={cn(buttonVariants({ variant: "outline", size: "touch" }), "shrink-0 gap-2")}
      >
        {t("dashboard:packages.pendingBanner.action")}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </div>
  );
}
