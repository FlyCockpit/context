import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/**
 * The public pages' one footer: the privacy notice. Anonymous visitors must be
 * able to read it, and every public page, the 404 included, renders it.
 * `PublicShell` renders it after the page, never a route: the scroller's
 * content is a `min-h-full` flex column, so on a short page this sits at the
 * bottom of the viewport and on a long one it follows the content. Cockpit
 * Context runs no analytics or tracking, so there is no cookie banner and no
 * "Cookie preferences" control (docs/product.md). See docs/ui.md § Shell rules
 */
export function PublicFooter({ lang }: { lang: string }) {
  const { t } = useTranslation(["privacy"]);
  return (
    <footer
      data-public-footer
      className="flex flex-wrap items-center justify-center gap-2 border-t px-4 py-6 pb-[calc(1.5rem_+_var(--safe-area-bottom))]"
    >
      <Link
        to="/$lang/privacy"
        params={{ lang }}
        className={cn(buttonVariants({ variant: "link", size: "touch" }))}
      >
        {t("privacy:footerLink")}
      </Link>
    </footer>
  );
}
