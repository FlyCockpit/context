import { createHash } from "node:crypto";
import { isAdminRole } from "@cockpit-context/auth/roles";
import prisma, { type Prisma } from "@cockpit-context/db";
import type { DataDeletionNotice } from "@cockpit-context/db/data-deletion-notices";
import {
  isEmailConfigured,
  type MailerLocale,
  renderDataDeleted,
  renderOperationalFailure,
  resolveMailerLocale,
  sendEmail,
} from "@cockpit-context/mailer";

const ALERT_COOLDOWN_SECONDS = 60 * 60;
const ADMIN_PAGE_SIZE = 50;
const EMAIL_CONCURRENCY = 8;
/** Distinct fingerprints remembered at once; oldest are evicted past this. */
const MAX_COOLDOWN_ENTRIES = 1_000;

const operationalAlertRecipientSelect = {
  id: true,
  email: true,
  role: true,
  locale: true,
} satisfies Prisma.UserSelect;

const operationalAlertRecipientWhere = {
  emailVerified: true,
  operationalAlerts: true,
};

/**
 * Cooldown reservations, process-local. Cockpit Context runs one app replica
 * (docs/hosting.md), so an in-memory map is the whole dedupe: one email per
 * (source, normalized message) per window. A restart forgets the reservations,
 * which can repeat one alert per restart; that is bounded by how often the
 * process restarts and is far better than the alternative failure (an inbox
 * flood from a failure that repeats every minute).
 */
type AlertSlot = { until: number; pending: boolean };
const cooldowns = new Map<string, AlertSlot>();

type OperationalAlert = {
  /** Cooldown namespace — one alert per (source, normalized message) per window. */
  source: string;
  /** Normalized into the cooldown fingerprint; numbers and ids are masked. */
  message: string;
  cooldownSeconds?: number;
} & (
  | { render: (locale: MailerLocale) => { subject: string; html: string } }
  | { subject: string; html: string }
);

/** Background job that ran out of attempts (or failed permanently). */
export async function sendJobFailureAlert(args: {
  type: string;
  id: string;
  attempts: number;
  error: string;
}): Promise<void> {
  await sendOperationalAlert({
    source: args.type,
    message: args.error,
    render: (locale) => renderOperationalFailure({ kind: "job", ...args, locale }),
  });
}

/**
 * A checkout summary run that ended `failed`. Its `checkout.summarize` job
 * succeeded once it started the run, so this names the run, not a job. Same
 * `source` as that job's failure alert, so the two share one cooldown.
 */
export async function sendSummaryRunFailureAlert(args: {
  jobType: string;
  runId: string;
  checkoutId: string;
  error: string;
}): Promise<void> {
  await sendOperationalAlert({
    source: args.jobType,
    message: args.error,
    render: (locale) =>
      renderOperationalFailure({ kind: "summary", ...args, type: args.jobType, locale }),
  });
}

/**
 * Email every admin who opted into operational alerts, at most once per
 * cooldown window per fingerprint. Safe to call when SMTP is unconfigured
 * (no-op).
 */
export async function sendOperationalAlert(alert: OperationalAlert): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const reservation = reserveAlertSlot(alert);
  if (!reservation) return 0;
  const { key, slot } = reservation;
  let delivered = 0;
  try {
    let afterId: string | undefined;
    for (;;) {
      const admins = await prisma.user.findMany({
        where: {
          // Roles are comma-separated tokens; filter with the authoritative parser.
          ...operationalAlertRecipientWhere,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: operationalAlertRecipientSelect,
        orderBy: { id: "asc" },
        take: ADMIN_PAGE_SIZE,
      });
      if (admins.length === 0) break;
      afterId = admins[admins.length - 1]?.id;
      const recipients = admins.filter((admin) => isAdminRole(admin.role));
      for (let i = 0; i < recipients.length; i += EMAIL_CONCURRENCY) {
        const results = await Promise.allSettled(
          recipients.slice(i, i + EMAIL_CONCURRENCY).map(async (admin) => {
            const content =
              "render" in alert
                ? alert.render(resolveMailerLocale(admin.locale))
                : { subject: alert.subject, html: alert.html };
            await sendEmail({ to: admin.email, ...content });
          }),
        );
        delivered += results.filter((result) => result.status === "fulfilled").length;
      }
      if (admins.length < ADMIN_PAGE_SIZE || !afterId) break;
    }
    return delivered;
  } finally {
    // Failed lookups and rejected sends must leave the next occurrence free to retry.
    // Compare reservation identity so an older send cannot release a newer slot.
    slot.pending = false;
    if (delivered === 0 && cooldowns.get(key) === slot) cooldowns.delete(key);
  }
}

/** A separate namespace per migration keeps numeric migration names distinct. */
export function sendDataDeletedAlert(notice: DataDeletionNotice): Promise<number> {
  return sendOperationalAlert({
    source: `data-deleted:${notice.name}`,
    message: notice.name,
    render: (locale) => renderDataDeleted({ ...notice, locale }),
  });
}

function reserveAlertSlot(args: {
  source: string;
  message: string;
  cooldownSeconds?: number;
}): { key: string; slot: AlertSlot } | null {
  const fingerprint = createHash("sha256")
    .update(args.source)
    .update("\0")
    .update(normalizeError(args.message))
    .digest("hex")
    .slice(0, 32);
  const key = `${args.source}:${fingerprint}`;
  const now = Date.now();
  const heldUntil = cooldowns.get(key);
  if (heldUntil && (heldUntil.pending || heldUntil.until > now)) return null;
  for (const [entry, slot] of cooldowns) {
    if (!slot.pending && slot.until <= now) cooldowns.delete(entry);
  }
  while (cooldowns.size >= MAX_COOLDOWN_ENTRIES) {
    const oldest = cooldowns.keys().next().value;
    if (oldest === undefined) break;
    cooldowns.delete(oldest);
  }
  const slot = {
    until: now + (args.cooldownSeconds ?? ALERT_COOLDOWN_SECONDS) * 1000,
    pending: true,
  };
  cooldowns.set(key, slot);
  return { key, slot };
}

/** Test hook: forget every reservation. */
export function resetOperationalAlertCooldowns(): void {
  cooldowns.clear();
}

function normalizeError(message: string): string {
  return message
    .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replaceAll(/\b\d+\b/g, "<number>")
    .trim()
    .slice(0, 500);
}
