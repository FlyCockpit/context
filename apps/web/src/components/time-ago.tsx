import { useTranslation } from "react-i18next";

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const FORMATTERS = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = FORMATTERS.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    FORMATTERS.set(locale, formatter);
  }
  return formatter;
}

const ABSOLUTE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The exact time for the title: what `toLocaleString` gives, built once per locale. */
function absoluteFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = ABSOLUTE_FORMATTERS.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
    ABSOLUTE_FORMATTERS.set(locale, formatter);
  }
  return formatter;
}

/**
 * Relative time ("8 minutes ago") with the exact time in the element's title
 * and `datetime`. A missing value reads "Never". Ported from ws-model-proxy.
 */
export function TimeAgo({
  value,
  now = Date.now(),
}: {
  value: Date | string | null;
  now?: number;
}) {
  const { t, i18n } = useTranslation(["dashboard"]);
  if (!value) return <span>{t("dashboard:time.never")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span>{t("dashboard:time.never")}</span>;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const [unit, size] = UNITS.find(([, span]) => Math.abs(seconds) >= span) ?? ["second", 1];
  const text = relativeFormatter(i18n.language).format(Math.round(seconds / size), unit);
  return (
    <time dateTime={date.toISOString()} title={absoluteFormatter(i18n.language).format(date)}>
      {text}
    </time>
  );
}
