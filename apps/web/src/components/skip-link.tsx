import { useTranslation } from "react-i18next";

/** The id of the region a keyboard user lands on: AppFrame's page column. */
export const MAIN_CONTENT_ID = "main-content";

/**
 * "Skip to content": the first stop in the tab order, hidden until focused.
 * It jumps past the header and the sidebar to the page itself (AppFrame's
 * column, else the shell's `main`), so keyboard users don't tab through a
 * dozen nav links on every page. Focus moves in the handler rather than by
 * following `#main-content`, which would put a hash in the router's URL.
 */
export function SkipLink() {
  const { t } = useTranslation("nav");
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={(event) => {
        const target =
          document.getElementById(MAIN_CONTENT_ID) ?? document.querySelector<HTMLElement>("main");
        if (!target) return;
        event.preventDefault();
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus();
      }}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:start-4 focus-visible:top-2 focus-visible:z-[60] focus-visible:inline-flex focus-visible:min-h-11 focus-visible:items-center focus-visible:rounded-md focus-visible:bg-background focus-visible:px-4 focus-visible:text-sm focus-visible:font-medium focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t("skipToContent")}
    </a>
  );
}
