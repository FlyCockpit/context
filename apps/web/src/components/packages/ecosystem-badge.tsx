import { cn } from "@cockpit-context/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Boxes, Cog, GitBranch, Hexagon, Rabbit } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Ecosystem } from "@/lib/packages";

/** One tint and glyph per ecosystem; the label always says which, so color is never the only signal. */
const ECOSYSTEM_STYLE: Record<Ecosystem, { icon: LucideIcon; tint: string }> = {
  npm: { icon: Hexagon, tint: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  pypi: { icon: Boxes, tint: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  cargo: { icon: Cog, tint: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  go: { icon: Rabbit, tint: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300" },
  git: { icon: GitBranch, tint: "bg-muted text-muted-foreground" },
};

/** The tile in front of a package row: the ecosystem glyph, labelled for screen readers. */
export function EcosystemIcon({
  ecosystem,
  className,
}: {
  ecosystem: Ecosystem;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const { icon: Icon, tint } = ECOSYSTEM_STYLE[ecosystem];
  return (
    <span
      role="img"
      aria-label={t(`dashboard:packages.ecosystems.${ecosystem}`)}
      className={cn("grid size-10 shrink-0 place-items-center rounded-lg", tint, className)}
    >
      <Icon aria-hidden="true" className="size-5" />
    </span>
  );
}

/** A small "npm" / "PyPI" label. */
export function EcosystemBadge({
  ecosystem,
  className,
}: {
  ecosystem: Ecosystem;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const { icon: Icon, tint } = ECOSYSTEM_STYLE[ecosystem];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tint,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {t(`dashboard:packages.ecosystems.${ecosystem}`)}
    </span>
  );
}
