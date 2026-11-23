import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

// On phones the control sits in the Password label's row: its 44px box fills
// the space from the email input's bottom edge to the password input's top
// edge (the wrapper's 6px `pt` makes that space 44px) and never overlaps
// either input; the label is aligned to the box's bottom. From `sm` up it
// keeps its own row under the field.
const SLOT = "text-right max-sm:absolute max-sm:-top-4 max-sm:right-0 max-sm:mt-0";
const CONTROL =
  "min-h-[44px] px-0 text-sm text-muted-foreground max-sm:h-11 max-sm:items-end max-sm:pb-[5px]";

/**
 * What the sign-in form offers a user who forgot their password, rendered
 * after the Password field inside a `relative` wrapper.
 *
 * With SMTP it links to the reset flow. Without SMTP there is no reset flow,
 * so the form says so instead of silently omitting the link (docs/product.md):
 * from `sm` up the note is always shown; on phones a "Forgot password?" toggle
 * in the label row reveals it, so the note's three or four lines do not push
 * the login page's sign-up link below the BottomNav at 320×568 (with an SSO
 * button above the form they did).
 */
export function PasswordHelp({
  lang,
  redirectTo,
  passwordResetAvailable,
}: {
  lang: string;
  redirectTo: string;
  passwordResetAvailable: boolean;
}) {
  const { t } = useTranslation(["auth"]);
  const [noteOpen, setNoteOpen] = useState(false);
  const noteId = useId();

  if (passwordResetAvailable) {
    return (
      <div className={SLOT}>
        <Link
          to="/$lang/forgot-password"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants({ variant: "link" }), CONTROL)}
        >
          {t("auth:login.forgotPassword")}
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className={cn(SLOT, "sm:hidden")}>
        <button
          type="button"
          aria-expanded={noteOpen}
          aria-controls={noteId}
          onClick={() => setNoteOpen((open) => !open)}
          className={cn(buttonVariants({ variant: "link" }), CONTROL)}
        >
          {t("auth:login.forgotPassword")}
        </button>
      </div>
      <p id={noteId} className={cn("text-sm text-muted-foreground", !noteOpen && "max-sm:hidden")}>
        {t("auth:login.passwordResetUnavailable")}
      </p>
    </>
  );
}
