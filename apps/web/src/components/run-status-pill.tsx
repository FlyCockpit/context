import { useTranslation } from "react-i18next";

import { type PillTone, StatusPill } from "@/components/status-pill";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";

const TONE: Record<RunStatus, PillTone> = {
  queued: "info",
  running: "busy",
  completed: "good",
  failed: "bad",
  stopped: "muted",
  interrupted: "muted",
};

/** A conversation's latest main-run status, in words (`dashboard:runStatus.*`). */
export function RunStatusPill({ status }: { status: RunStatus }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <StatusPill tone={TONE[status]}>
      {status === "running" ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {t(`dashboard:runStatus.${status}`)}
    </StatusPill>
  );
}
