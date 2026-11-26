import { buttonVariants } from "@cockpit-context/ui/components/button";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { PAGE_COLUMN_CLASS } from "@/components/page-shell";
import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

/**
 * Nudges a signed-in admin who has not enrolled a TOTP second factor.
 *
 * Enrollment is REQUIRED for admins unless the owner has explicitly turned
 * `force2faInternalUsers` off, so this banner has three voices:
 *   - inside the enrollment grace window → required, with the deadline;
 *   - past it → the gates are already rejecting them, say so;
 *   - enforcement explicitly disabled → the original advisory nudge.
 * It always names where the policy is configured, because the owner reading
 * this banner is usually the person who can change it.
 *
 * A compact band at every width: one row with a short title and the "Set up
 * 2FA" action, the explanation behind a disclosure. It sits above full-height
 * pages such as a conversation (which fills what is left of the frame, see
 * AppFrame), so every pixel it takes comes out of the transcript; on a phone
 * the full text used to push the composer off-screen.
 *
 * Links to the existing /settings/security enrollment flow rather than
 * duplicating it. Rendered by the admin layout; renders nothing until the
 * session and settings resolve, so it never flashes the wrong copy.
 */
export function TwoFactorNudge() {
  const { t, i18n } = useTranslation("admin");
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { data: appSettings } = useQuery(orpc.settings.getAll.queryOptions());
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  if (authSession.state.status !== "authenticated") return null;
  const user = authSession.state.session.user;
  if (user.twoFactorEnabled === true) return null;
  if (!appSettings) return null;

  const enrollment = twoFactorEnrollmentState(appSettings, user);
  if (enrollment.status === "enrolled") return null;

  const deadline =
    enrollment.status === "grace"
      ? formatRelativeTime(enrollment.deadlineMs, i18n.language)
      : undefined;
  const title =
    enrollment.status === "grace"
      ? t("twoFactorNudge.requiredTitle", { deadline })
      : enrollment.status === "blocked"
        ? t("twoFactorNudge.blockedTitle")
        : t("twoFactorNudge.title");
  const message =
    enrollment.status === "grace"
      ? t("twoFactorNudge.requiredMessage", { deadline })
      : enrollment.status === "blocked"
        ? t("twoFactorNudge.blockedMessage")
        : t("twoFactorNudge.message");

  return (
    <div
      role="alert"
      className="shrink-0 border-b border-yellow-300 bg-yellow-100 py-1 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
    >
      {/* The band spans the window; its content sits in the widest page
          column (docs/ui.md § Viewport scale). */}
      <div className={cn(PAGE_COLUMN_CLASS, "flex min-w-0 items-center gap-2")}>
        <ShieldAlert className="size-5 shrink-0" aria-hidden="true" />
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((open) => !open)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-start font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0">{title}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
          <span className="sr-only">{t("twoFactorNudge.details")}</span>
        </button>
        <Link
          to="/$lang/settings/security"
          params={{ lang }}
          className={cn(buttonVariants({ variant: "outline", size: "touch" }), "shrink-0")}
        >
          {t("twoFactorNudge.cta")}
        </Link>
      </div>
      <div
        id={detailsId}
        hidden={!expanded}
        className={cn(PAGE_COLUMN_CLASS, "space-y-1 ps-11 pb-2")}
      >
        <p className="max-w-prose text-yellow-900/90 dark:text-yellow-100/90">{message}</p>
        <p className="max-w-prose text-yellow-900/80 dark:text-yellow-100/80">
          {t("twoFactorNudge.configurable")}
        </p>
      </div>
    </div>
  );
}
