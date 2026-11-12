import { env } from "@cockpit-context/env/shared";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

let transporter: Transporter | null = null;

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 30_000;
const SEND_ATTEMPTS = 3;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;

  if (!SMTP_HOST) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in your .env file. " +
        "For local dev, run: docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit",
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ?? 587,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    // Milliseconds. nodemailer's defaults (2 min connect, 30 s greeting, 10 min
    // socket idle) let one unreachable server hold a request or a job slot for
    // many minutes across the retries below.
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });

  return transporter;
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
 * The nodemailer transport is created lazily on the first call so the
 * application boots cleanly even when SMTP is not configured.
 * Shipped callers send account mail. Marketing needs a separate flow with
 * unsubscribe, postal address, and dispatch-time suppression (including
 * retries); do not add promotions to auth mail. See docs/product.md.
 */
export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const transport = getTransporter();
  const from = env.SMTP_FROM;
  if (!from) {
    throw new Error(
      "SMTP_FROM is not set. Outgoing email needs an explicit From: address — " +
        'set SMTP_FROM in your .env (e.g. "App Name <no-reply@yourdomain.com>").',
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await transport.sendMail({ from, to, subject, html });
      return;
    } catch (err) {
      lastError = err;
      if (isPermanentSmtpRejection(err)) break;
      if (attempt < SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
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
  try {
    return await getTransporter().verify();
  } catch {
    return false;
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
