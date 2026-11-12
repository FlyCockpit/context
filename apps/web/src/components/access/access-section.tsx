import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";

/** The heading above one Access tab's list: what it is, plus its primary action. */
export function AccessSectionHeader({
  titleId,
  title,
  description,
  actions,
}: {
  /** The heading's id, for the section's `aria-labelledby`. */
  titleId: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 id={titleId} className="text-lg font-semibold text-balance">
          {title}
        </h2>
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** The tinted icon tile that leads a credential row. */
export function RowIcon({ icon: Icon, muted = false }: { icon: LucideIcon; muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg",
        muted ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary-text",
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

export type CredentialState = "active" | "expired" | "revoked";

/** `kind` picks the wording: es-MX agrees in gender ("token" vs "conexión"). */
export function CredentialStatePill({
  state,
  kind,
}: {
  state: CredentialState;
  kind: "token" | "connection";
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <StatusPill tone={state === "active" ? "good" : state === "revoked" ? "bad" : "muted"}>
      {t(`dashboard:access.state.${kind}.${state}`)}
    </StatusPill>
  );
}

/** "Created 3 days ago · Last used 5 minutes ago · Expires in 2 months", wrapping on narrow screens. */
export function CredentialDates({
  createdAt,
  lastUsedAt,
  expiresAt,
}: {
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  /** Omit for credentials that never carry an expiry (connections, keys). */
  expiresAt?: Date | string | null;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>
        {t("dashboard:access.dates.created")} <TimeAgo value={createdAt} />
      </span>
      <span>
        {t("dashboard:access.dates.lastUsed")}{" "}
        {lastUsedAt ? <TimeAgo value={lastUsedAt} /> : t("dashboard:access.dates.neverUsed")}
      </span>
      {expiresAt === undefined ? null : expiresAt === null ? (
        <span>{t("dashboard:access.dates.noExpiry")}</span>
      ) : (
        <span>
          {t("dashboard:access.dates.expires")} <TimeAgo value={expiresAt} />
        </span>
      )}
    </p>
  );
}

export function AccessRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="divide-y" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => `row-${index}`).map((key) => (
        <li key={key} className="flex items-start gap-3 px-4 py-4">
          <Skeleton className="size-10 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
