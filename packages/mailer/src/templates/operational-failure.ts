import en from "../locales/en-US/operational-failure.json";
import es from "../locales/es-MX/operational-failure.json";
import { resolveMailerLocale } from "../locales/index.js";
import { escapeHtml } from "./html.js";

type Failure =
  | { kind: "job"; type: string; id: string; attempts: number; error: string }
  | { kind: "summary"; type: string; runId: string; checkoutId: string; error: string };

export function renderOperationalFailure(args: Failure & { locale: string }): {
  subject: string;
  html: string;
} {
  const locale = resolveMailerLocale(args.locale);
  const t = locale === "es-MX" ? es : en;
  const detail = (label: string, value: string) =>
    `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
  return {
    subject: `[${args.type}] ${args.kind === "job" ? t.jobSubject : t.summarySubject}`,
    html: `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8" /></head><body>
      <p>${escapeHtml(args.kind === "job" ? t.jobBody : t.summaryBody)}</p><dl>
      ${detail(t.typeLabel, args.type)}
      ${args.kind === "job" ? detail(t.jobLabel, args.id) + detail(t.attemptsLabel, String(args.attempts)) : detail(t.runLabel, args.runId) + detail(t.checkoutLabel, args.checkoutId)}
      ${detail(t.errorLabel, args.error)}</dl></body></html>`,
  };
}
