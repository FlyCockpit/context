import { env } from "@cockpit-context/env/shared";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import SMTPConnection from "nodemailer/lib/smtp-connection";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 15_000;
const SEND_ATTEMPTS = 3;
/**
 * One budget for a whole `sendEmail` call, every attempt and backoff
 * included. The per-socket timeouts above bound an idle relay, not one that
 * trickles bytes, and three attempts of them could add up to minutes; a
 * request that sends mail must answer well inside a reverse proxy's idle
 * limit (Cloudflare: 100 s, docs/deploy.md § Home server behind a Cloudflare
 * Tunnel).
 */
export const SEND_DEADLINE_MS = 40_000;
/** `verifyTransport` (a login preflight) gets a shorter budget of its own. */
export const VERIFY_DEADLINE_MS = 15_000;
/** Shortest budget worth starting another attempt with. */
const MIN_ATTEMPT_MS = 5_000;

/** A send (or verify) that ran out of its overall budget. Never retried. */
export class SmtpDeadlineError extends Error {
  constructor(ms: number) {
    super(`SMTP did not finish within ${Math.round(ms / 1000)} s.`);
    this.name = "SmtpDeadlineError";
  }
}

/**
 * `work` or a `SmtpDeadlineError` after `ms`, whichever settles first. The
 * transport has no abort: a late attempt finishes (or hits its socket
 * timeout) in the background, and its outcome is ignored.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpDeadlineError(ms)), ms);
  });
  // A rejection after the deadline already won must not be unhandled.
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A transport of its own for one send (or verify), closed when that is done,
 * including when its budget ran out: a pooled transport's `close()` ends its
 * open connection, so an attempt cut off by the deadline does not go on in
 * the background (and cannot deliver a link the caller already revoked).
 */
/**
 * nodemailer's pool takes `close({ force: true })` (smtp-pool: "also close
 * connections that are delivering a message", for a caller that gave up on a
 * relay trickling its replies); the typings only know `close()`.
 */
type PoolTransporter = Transporter & { close(options: { force: true }): void };

function smtpSettings() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;

  if (!SMTP_HOST) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in your .env file. " +
        "For local dev, run: docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit",
    );
  }

  return {
    host: SMTP_HOST,
    port: SMTP_PORT ?? 587,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    // Milliseconds. nodemailer's defaults (2 min connect, 30 s greeting, 10 min
    // socket idle) let one unreachable server hold a request or a job slot for
    // many minutes across the retries below.
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };
}

function createTransporter(): PoolTransporter {
  const transport = nodemailer.createTransport({
    ...smtpSettings(),
    // One connection, closable at any time (see above).
    pool: true,
    maxConnections: 1,
  });
  return transport as PoolTransporter;
}

/**
 * A 5xx SMTP reply is a permanent rejection (bad recipient, policy refusal,
 * auth failure): sending the same message again cannot succeed. 4xx replies
 * and network or timeout errors (no `responseCode`) are worth retrying.
 */
function isPermanentSmtpRejection(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("responseCode" in err)) return false;
  const { responseCode } = err;
  return typeof responseCode === "number" && responseCode >= 500;
}

/**
 * Send an email using the SMTP transport configured via env vars.
 *
 * Each call gets a transport of its own (so the application boots cleanly
 * without SMTP, and a send cut off by its budget is closed, not left running).
 * Shipped callers send account mail. Marketing needs a separate flow with
 * unsubscribe, postal address, and dispatch-time suppression (including
 * retries); do not add promotions to auth mail. See docs/product.md.
 */
export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const from = env.SMTP_FROM;
  if (!from) {
    throw new Error(
      "SMTP_FROM is not set. Outgoing email needs an explicit From: address — " +
        'set SMTP_FROM in your .env (e.g. "App Name <no-reply@yourdomain.com>").',
    );
  }
  const transport = createTransporter();
  try {
    await sendWithin(transport, { from, to, subject, html });
  } finally {
    // Ends the connection even mid-delivery: an attempt the deadline cut off
    // cannot complete later (its DATA stream is detached from the socket).
    transport.close({ force: true });
  }
}

async function sendWithin(
  transport: Transporter,
  message: { from: string; to: string; subject: string; html: string },
): Promise<void> {
  const startedAt = Date.now();
  const remaining = () => SEND_DEADLINE_MS - (Date.now() - startedAt);
  let lastError: unknown;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await withDeadline(transport.sendMail(message), remaining());
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof SmtpDeadlineError || isPermanentSmtpRejection(err)) break;
      const backoff = attempt * 500;
      // Another attempt only when it would still have a real chance to finish.
      if (attempt < SEND_ATTEMPTS && remaining() - backoff >= MIN_ATTEMPT_MS) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

/**
 * Send after the response: for mail whose outcome the caller cannot report
 * anyway. Held in memory only (the message can carry a one-time code, so it
 * is never written to the job table); a failure is logged. Returns at once.
 */
export function queueEmail(options: SendEmailOptions, label: string): void {
  void Promise.resolve()
    .then(() => sendEmail(options))
    .catch((err: unknown) => {
      const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
      console.warn(`[mailer] queued ${label} email failed:`, errLabel);
    });
}

/**
 * Whether SMTP is configured at all (env-level check, no network I/O). Drives
 * the `emailConfigured` app-config flag that gates email-dependent UI.
 */
export function isEmailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

/**
 * Best-effort SMTP reachability check (connect + auth handshake via nodemailer's
 * `verify()`). Returns a boolean and NEVER throws: `false` when SMTP is
 * unconfigured or the handshake fails, `true` otherwise.
 *
 * Used as a delivery-aware preflight: Better-Auth's email-OTP `send-otp`
 * endpoint swallows `sendOTP` failures and always returns success, so callers
 * verify the transport is actually reachable before telling a user a code is on
 * the way. This catches the common breakage (wrong host/port/credentials, server
 * down); it cannot guarantee a specific recipient won't bounce after a good
 * handshake — that is inherent to asynchronous email delivery.
 */
export async function verifyTransport(): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  // One SMTP connection of our own (a pool's verify() opens a connection the
  // pool cannot close), closed whatever happens, so a relay stalling the
  // handshake past the deadline is not left holding a socket.
  const { auth, ...options } = smtpSettings();
  const connection = new SMTPConnection(options);
  try {
    return await withDeadline(
      new Promise<boolean>((resolve, reject) => {
        connection.once("error", reject);
        connection.connect((connectError) => {
          if (connectError) return reject(connectError);
          // As the pool does: authenticate only when the relay offers AUTH
          // (a trusted relay may accept mail without it).
          if (!auth || !connection.allowsAuth) return resolve(true);
          connection.login(auth, (loginError) => (loginError ? reject(loginError) : resolve(true)));
        });
      }),
      VERIFY_DEADLINE_MS,
    );
  } catch {
    return false;
  } finally {
    connection.close();
  }
}

// Locale machinery + per-template renderers. The mailer owns email rendering
// (subject + HTML) so callers don't have to think about i18n bundles, just
// pass the recipient's locale and the template-specific data.
export {
  DEFAULT_MAILER_LOCALE,
  isMailerLocale,
  MAILER_LOCALES,
  type MailerLocale,
  resolveMailerLocale,
} from "./locales/index.js";
export { type RenderDataDeletedArgs, renderDataDeleted } from "./templates/data-deleted.js";
// Shared HTML escaping for callers that build their own email bodies.
export { escapeHtml } from "./templates/html.js";
export {
  type RenderInviteUserArgs,
  type RenderInviteUserResult,
  renderInviteUser,
} from "./templates/invite-user.js";
export { renderOperationalFailure } from "./templates/operational-failure.js";
export {
  type RenderResetPasswordArgs,
  type RenderResetPasswordResult,
  renderResetPassword,
} from "./templates/reset-password.js";
export {
  type RenderTwoFactorOtpArgs,
  type RenderTwoFactorOtpResult,
  renderTwoFactorOtp,
} from "./templates/two-factor-otp.js";
export {
  type RenderVerifyEmailArgs,
  type RenderVerifyEmailResult,
  renderVerifyEmail,
} from "./templates/verify-email.js";
