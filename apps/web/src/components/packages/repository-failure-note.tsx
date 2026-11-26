import { cn } from "@cockpit-context/ui/lib/utils";
import { useTranslation } from "react-i18next";

const REASONS = new Set([
  "auth",
  "notFound",
  "unreachable",
  "hostKey",
  "timeout",
  "interrupted",
  "invalidUrl",
  "privateAddress",
  "sshKey",
  "snapshot",
  "other",
]);

/**
 * Why a clone or fetch failed, in plain words with the next step, under the
 * "Failed" label. `reason` is the server's fixed `failureReason` (never git
 * output). The package owner and an admin get different next steps: only the
 * owner can change the package's URL or key.
 */
export function RepositoryFailureNote({
  reason,
  audience,
  className,
}: {
  reason: string | null;
  audience: "owner" | "admin";
  className?: string;
}) {
  const { t } = useTranslation(["dashboard", "admin"]);
  if (!reason) return null;
  const key = REASONS.has(reason) ? reason : "other";
  return (
    <span
      data-slot="repository-failure"
      className={cn("block w-full text-xs text-pretty text-destructive", className)}
    >
      {audience === "owner"
        ? t(`dashboard:packages.repositoryFailure.${key}`)
        : t(`admin:storage.repositoryFailure.${key}`)}
    </span>
  );
}
