import { createHash, randomBytes } from "node:crypto";
import { BASE_ERROR_CODES } from "better-auth";
import { APIError } from "better-auth/api";

/**
 * Set-password links (admin invites, `users.passwordLink`, forgot-password)
 * and what spending one proves.
 *
 * Every link is Better-Auth's own password-reset token: a
 * `reset-password:<token>` verification row whose value is the user id. A
 * link proves the person spending it controls the address only if it was
 * *mailed* to that address. So, per token, after a mail carrying the link was
 * accepted, {@link recordResetLinkMailed} writes a "mailed" row bound to the
 * user and the address. Then:
 *
 * - Spending a mailed link verifies the address it went to
 *   ({@link verifyEmailIfResetLinkWasMailed}). A link the admin was shown (the
 *   invite email failed, or there is no SMTP) sets the password and verifies
 *   nothing: the invitee confirms their address by email at first sign-in.
 * - With SMTP on, a link that was not mailed is spendable only while the
 *   account is still a pending invite ({@link isResetLinkRedeemable}). So a
 *   link the admin was shown is dead once the invitee activated the account
 *   another way (verified it, linked an IdP identity, signed in): the admin
 *   cannot use it to set an active account's password (docs/access-matrix.md).
 * - Setting a password by any link deletes the user's other links
 *   ({@link deleteOtherResetLinks}).
 *
 * Everything here goes through Better-Auth's adapters, so it runs the same on
 * Postgres and on the in-memory adapter the tests drive the real endpoints
 * with. The `reap-expired-auth-tokens` job deletes every row once expired.
 */

/** Better-Auth's verification identifier prefix for password-reset tokens. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/** Better-Auth's endpoint that spends a reset token (`POST /api/auth/reset-password`). */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * The "this token was mailed" row: identifier `reset-password-mailed:<sha256(token)>`
 * (the token itself is never stored a second time), value the user id and the
 * lowercased address it went to (JSON), `expiresAt` the link's own. Not a
 * `reset-password:` prefix, so nothing that lists or deletes reset tokens
 * mistakes it for one.
 */
const MAILED_IDENTIFIER_PREFIX = "reset-password-mailed:";

function mailedIdentifier(token: string): string {
  return `${MAILED_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

function resetIdentifier(token: string): string {
  return `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
}

type VerificationRow = { value: string; expiresAt: Date | string };

/** The slice of Better-Auth's `internalAdapter` a set-password token needs. */
export interface VerificationValueWriter {
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
}

/** The slice of Better-Auth's `internalAdapter` the link rules read and write. */
export interface ResetLinkAdapter extends VerificationValueWriter {
  findVerificationValue(identifier: string): Promise<VerificationRow | null | undefined>;
  consumeVerificationValue(identifier: string): Promise<VerificationRow | null | undefined>;
  findUserById(
    userId: string,
  ): Promise<{ email: string; emailVerified?: boolean | null } | null | undefined>;
  updateUser(userId: string, data: { emailVerified: boolean }): Promise<unknown>;
  findAccounts(userId: string): Promise<Array<{ providerId: string }>>;
  listSessions(userId: string): Promise<unknown[]>;
}

/** The slice of Better-Auth's database adapter (`ctx.adapter`) the cleanup needs. */
export interface VerificationRowDeleter {
  deleteMany(args: {
    model: "verification";
    where: Array<{ field: string; value: string; operator?: "starts_with" }>;
  }): Promise<unknown>;
}

/**
 * Writes a one-time set-password token for `userId` (an invite, or an
 * admin's `users.passwordLink`) and returns it. It is Better-Auth's own
 * password-reset token: the same `reset-password:<token>` verification row
 * (value = user id) its `requestPasswordReset` writes, so its
 * `/reset-password` endpoint consumes it once, for that user only, and refuses
 * it after `expiresAt`. 24 random bytes, url-safe: at least as strong as
 * Better-Auth's own `generateId(24)`.
 */
export async function createSetPasswordToken(
  adapter: VerificationValueWriter,
  userId: string,
  expiresAt: Date,
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await adapter.createVerificationValue({
    identifier: resetIdentifier(token),
    value: userId,
    expiresAt,
  });
  return token;
}

/**
 * Records that the link for `token` was mailed to `email`. Call it only after
 * the mail was accepted for delivery, never before: a record for a link that
 * was not mailed would let it verify an address nobody proved. User and expiry
 * come from the link's own row, so a link that is gone or expired records
 * nothing. Returns whether it recorded.
 */
export async function recordResetLinkMailed(
  adapter: Pick<ResetLinkAdapter, "findVerificationValue" | "createVerificationValue">,
  input: { token: string; email: string },
  now = new Date(),
): Promise<boolean> {
  const link = await adapter.findVerificationValue(resetIdentifier(input.token));
  if (!link || new Date(link.expiresAt) <= now) return false;
  await adapter.createVerificationValue({
    identifier: mailedIdentifier(input.token),
    value: JSON.stringify({ userId: link.value, email: input.email.toLowerCase() }),
    expiresAt: new Date(link.expiresAt),
  });
  return true;
}

function parseMailed(value: string): { userId: string; email: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.userId === "string" && typeof parsed.email === "string") {
      return { userId: parsed.userId, email: parsed.email };
    }
  } catch {
    // A malformed row proves nothing.
  }
  return null;
}

/**
 * Whether a `POST /reset-password` may spend `token` (the Better-Auth
 * before-hook). An unknown or expired token is left to Better-Auth, which
 * refuses it. A mailed link is spendable in every account state. A link that
 * was not mailed is spendable, with SMTP on, only while the account is still a
 * pending invite: unverified, no identity besides its password credential (an
 * IdP link activates it), and no live session. Otherwise it is refused, and
 * refused again on every later try while the account stays active;
 * the row is left to expire, so a mailed record that commits a moment after a
 * very early click still lets the next try through.
 *
 * A link whose mailed record failed to write counts as not mailed: refused for
 * an active account (fail closed); the user requests another.
 *
 * With SMTP off nothing is mailed, every account is created verified, and the
 * admin's `users.passwordLink` hands out links for active accounts by design
 * (audited), so nothing is judged.
 *
 * Better-Auth spends the token after this check, so an activation committing
 * in between is the allowed order "reset, then activation".
 */
export async function isResetLinkRedeemable(
  adapter: ResetLinkAdapter,
  token: string,
  options: { emailConfigured: boolean; now?: Date },
): Promise<boolean> {
  if (!options.emailConfigured) return true;
  const now = options.now ?? new Date();
  const link = await adapter.findVerificationValue(resetIdentifier(token));
  if (!link || new Date(link.expiresAt) <= now) return true;
  const userId = link.value;
  const mailed = await adapter.findVerificationValue(mailedIdentifier(token));
  if (mailed && new Date(mailed.expiresAt) > now && parseMailed(mailed.value)?.userId === userId) {
    return true;
  }
  const [user, accounts, sessions] = await Promise.all([
    adapter.findUserById(userId),
    adapter.findAccounts(userId),
    adapter.listSessions(userId),
  ]);
  const pendingInvite =
    !!user &&
    user.emailVerified !== true &&
    accounts.every((account) => account.providerId === "credential") &&
    sessions.length === 0;
  return pendingInvite;
}

/**
 * After a successful reset with `token` (the Better-Auth after-hook): consumes
 * the token's mailed record and, if the user's address is still the one the
 * link went to, marks it verified. Returns whether it verified.
 */
export async function verifyEmailIfResetLinkWasMailed(
  adapter: ResetLinkAdapter,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const row = await adapter.consumeVerificationValue(mailedIdentifier(token));
  if (!row || new Date(row.expiresAt) <= now) return false;
  const mailed = parseMailed(row.value);
  if (!mailed) return false;
  const user = await adapter.findUserById(mailed.userId);
  if (!user || user.email.toLowerCase() !== mailed.email) return false;
  if (user.emailVerified !== true) {
    await adapter.updateUser(mailed.userId, { emailVerified: true });
  }
  return true;
}

/**
 * Called from `emailAndPassword.onPasswordReset`, after Better-Auth has
 * committed the new password and consumed the spent token: the user just chose
 * a password, so every other link for them is dead (one the admin was shown,
 * an older forgot-password mail). Their mailed records are inert without the
 * link and are reaped once expired.
 */
export async function deleteOtherResetLinks(
  adapter: VerificationRowDeleter,
  userId: string,
): Promise<void> {
  await adapter.deleteMany({
    model: "verification",
    where: [
      { field: "identifier", operator: "starts_with", value: RESET_PASSWORD_IDENTIFIER_PREFIX },
      { field: "value", value: userId },
    ],
  });
}

/** The token a `POST /reset-password` request carries (body or query), or null. */
export function resetTokenOf(ctx: {
  path?: string;
  body?: unknown;
  query?: unknown;
}): string | null {
  if (ctx.path !== RESET_PASSWORD_PATH) return null;
  const token =
    (isRecord(ctx.body) ? ctx.body.token : undefined) ||
    (isRecord(ctx.query) ? ctx.query.token : undefined);
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** The endpoint context Better-Auth hands a hook, as far as these rules read it. */
export interface ResetLinkHookContext {
  path?: string;
  body?: unknown;
  query?: unknown;
  context: { internalAdapter: ResetLinkAdapter; returned?: unknown };
}

function errorLabel(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

/**
 * The Better-Auth wiring of these rules, shared by packages/auth/src/index.ts
 * and the tests that drive the real endpoints, so both run the same code.
 */
export function createResetLinkHooks(options: { emailConfigured: boolean }) {
  return {
    /** `hooks.before`: refuse a link that may not be spent, exactly like an expired one. */
    async before(ctx: ResetLinkHookContext): Promise<void> {
      const token = resetTokenOf(ctx);
      if (token && !(await isResetLinkRedeemable(ctx.context.internalAdapter, token, options))) {
        throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_TOKEN);
      }
    },
    /**
     * `hooks.after`: a spent mailed link verifies the address. The password is
     * already set, so a failure is logged, never surfaced: the user can verify
     * through the verification email sign-in sends.
     */
    async after(ctx: ResetLinkHookContext): Promise<void> {
      const returned = ctx.context.returned;
      if (!isRecord(returned) || returned.status !== true) return;
      const token = resetTokenOf(ctx);
      if (!token) return;
      try {
        await verifyEmailIfResetLinkWasMailed(ctx.context.internalAdapter, token);
      } catch (err) {
        console.error("[auth] verifying the email of a mailed reset link failed:", errorLabel(err));
      }
    },
    /** `onPasswordReset`: the user's other links die. Logged, never surfaced. */
    async afterPasswordReset(adapter: VerificationRowDeleter, userId: string): Promise<void> {
      try {
        await deleteOtherResetLinks(adapter, userId);
      } catch (err) {
        console.error("[auth] deleting the user's other reset links failed:", errorLabel(err));
      }
    },
    /**
     * `sendResetPassword`, after the mail went out: record it. A failed record
     * is logged; the link then counts as not mailed (fail closed).
     */
    async afterResetMailSent(
      adapter: ResetLinkAdapter,
      input: { token: string; email: string },
    ): Promise<void> {
      try {
        await recordResetLinkMailed(adapter, input);
      } catch (err) {
        console.error("[auth] recording a mailed reset link failed:", errorLabel(err));
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
