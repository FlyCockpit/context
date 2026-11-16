import { useTranslation } from "react-i18next";

import { costCertainty, formatUsdMicros } from "@/lib/conversations";

/**
 * A conversation's cost. When any model call came back without a price the
 * amount is only the priced part, so it is marked as a lower bound ("≥ $0.04,
 * some calls unpriced") or as unknown — never shown as a plain total.
 * `compact` (list rows) shows the short form and keeps the full wording for
 * the tooltip and screen readers.
 */
export function ConversationCost({
  costUsdMicros,
  unpricedCalls,
  compact = false,
}: {
  costUsdMicros: number;
  unpricedCalls: number;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const amount = formatUsdMicros(costUsdMicros, i18n.language);
  const certainty = costCertainty(costUsdMicros, unpricedCalls);
  if (certainty === "priced") return <>{amount}</>;
  const full = t(`dashboard:conversation.cost.${certainty}`, { amount });
  if (!compact) return <>{full}</>;
  return (
    <span title={full}>
      <span aria-hidden="true">
        {t(`dashboard:conversation.cost.${certainty}Short`, { amount })}
      </span>
      <span className="sr-only">{full}</span>
    </span>
  );
}
