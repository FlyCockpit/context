import en from "../locales/en-US/data-deleted.json";
import es from "../locales/es-MX/data-deleted.json";
import { resolveMailerLocale } from "../locales/index.js";
import { escapeHtml } from "./html.js";

export interface RenderDataDeletedArgs {
  locale: string;
  name: string;
  effects: string | null;
  deletedAt: Date;
  backup: string | null;
  note: string | null;
}

/** Planned deletion notice; all migration-supplied content is escaped. */
export function renderDataDeleted(args: RenderDataDeletedArgs): { subject: string; html: string } {
  const locale = resolveMailerLocale(args.locale);
  const t = locale === "es-MX" ? es : en;
  const detail = (label: string, value: string) =>
    `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
  const html = `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8" /></head><body>
    <h1>${escapeHtml(t.heading)}</h1><p>${escapeHtml(t.body)}</p><dl>
    ${detail(t.effectsLabel, args.effects ?? t.effectsFallback)}
    ${detail(t.whenLabel, args.deletedAt.toISOString())}
    ${detail(t.changeLabel, args.name)}
    ${args.note ? detail(t.noteLabel, args.note) : ""}
    </dl>${args.backup ? `<p>${escapeHtml(t.backupLabel)} <strong>${escapeHtml(args.backup)}</strong></p><p>${escapeHtml(t.recovery)}</p>` : `<p>${escapeHtml(t.noBackup)}</p>`}
    </body></html>`;
  return { subject: t.subject, html };
}
