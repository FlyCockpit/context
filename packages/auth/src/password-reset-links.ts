import { createHash } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-context/db";
import { withLockSlot } from "./lock-slots.js";

/**
 * Password-reset links: forgot-password mails and admin-invite set-password
 * links. Both are Better-Auth `reset-password:<token>` verification rows
 * (value = user id), spent by Better-Auth's `POST /reset-password`.
 *
 * Spending one sets the password. It verifies the email only when that very
 * token was mailed to the address: the mail is the proof. A link the admin was
 * shown instead (the invite mail was not sent) proves nothing about the
 * mailbox, so spending it leaves the account unverified, and the person
 * verifies through the normal verify-email flow (sign-in mails them a link).
 * Otherwise an admin, or anyone the link was passed to, could make an address
 * nobody controls "verified".
 *
 * The "mailed" fact is a verification row next to the token
 * ({@link recordResetLinkMailed}): no schema change, and it expires with the
 * link (the `reap-expired-auth-tokens` job drops both).
 *
 * The same fact decides who may spend a link ({@link isResetLinkRedeemable}):
 * a mailed link works for any account, a link the admin was shown works only
 * while SMTP is configured and the account is still a pending invite ({@link isInvitePending}). So a
 * shown link left over after the invitee activated the account is dead at
 * redemption with SMTP, whether or not activation cleanup deleted it. Without
 * SMTP, existing private-mode admin links for active password accounts remain
 * redeemable, but never prove mailbox ownership.
 */

/** Better-Auth's verification identifier prefix for password-reset tokens. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/** Better-Auth's endpoint that spends a reset token (`POST /api/auth/reset-password`). */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * The "this token was mailed" row: identifier `reset-password-mailed:<sha256(token)>`
 * (the token itself is never stored a second time), value the user id and the
 * address it went to (JSON), `expiresAt` the link's own. Not a
 * `reset-password:` prefix, so nothing that lists or deletes reset tokens
 * mistakes it for one.
 */
const MAILED_IDENTIFIER_PREFIX = "reset-password-mailed:";

function mailedIdentifier(token: string): string {
  return `${MAILED_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/** Better-Auth's id for an email/password account (`Account.providerId`). */
export const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * Context considers an unverified account with no non-credential identity and
 * no live session pending, including before a credential row exists. Select
 * only one disqualifying IdP identity and one live session: both are bounded.
 */
export function inviteStateSelect(now: Date) {
  return {
    emailVerified: true,
    accounts: {
      where: { providerId: { not: CREDENTIAL_PROVIDER_ID } },
      select: { providerId: true },
      take: 1,
    },
    sessions: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
  } satisfies Prisma.UserSelect;
}

/**
 * Pending invite = an account nobody has started using: email not verified,
 * every Account row is email/password ("credential"), including no rows, and
 * no live session. This preserves Context's existing pending-invite policy.
 *
 * `emailVerified === false` alone is NOT enough. Better-Auth's genericOAuth
 * copies the IdP's `email_verified ?? false`, so an active SSO user can be
 * unverified; a set-password link for them would let whoever holds it add a
 * password next to the SSO identity — an account takeover that also skips the
 * IdP's MFA. The non-credential account rule covers that, and the live-session
 * rule covers an account in use by any other route.
 *
 * An invitee who set a password through a link the admin passed on is still
 * pending (unverified, so never signed in): fresh delivery mails another link,
 * and spending that one verifies the address.
 */
export function isInvitePending(row: {
  emailVerified: boolean;
  accounts: { providerId: string }[];
  sessions: { id: string }[];
}): boolean {
  return (
    !row.emailVerified &&
    row.accounts.every((account) => account.providerId === CREDENTIAL_PROVIDER_ID) &&
    row.sessions.length === 0
  );
}

/**
 * The per-user lock everything that mints a reset link or finishes a reset
 * takes, held until the calling transaction ends. Minting
 * (packages/api/src/routers/users.ts) checks target eligibility under it;
 * a finished reset deletes every other reset link of
 * the user under it. So an invite resend racing the invitee's own password
 * setup either sees the account set up and refuses, or mints a link the reset
 * then deletes: no working link to an activated account is left behind.
 */
// Setup lock follows password-write and user credentials; see docs/access-matrix.md.
export function lockCredentialSetup(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  userId: string,
): Prisma.PrismaPromise<number> {
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`set-password-link:${userId}`}))`;
}

/** Short setup work only; never hold this transaction during SMTP delivery. */
export function withCredentialSetupLock<T>(
  userId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withLockSlot(() =>
    prisma.$transaction(async (tx) => {
      await lockCredentialSetup(tx, userId);
      return run(tx);
    }),
  );
}

/** Every reset link of the user, spent or not. Run under {@link lockCredentialSetup}. */
export function deleteResetLinks(
  db: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
) {
  return db.verification.deleteMany({
    where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
}

/**
 * Records that the reset link `token` was mailed to `email` (call it only
 * after the mail was accepted for delivery). Returns false, and records
 * nothing, when the link is already gone (spent, replaced, expired): a late
 * record must never outlive its link. The check and the insert are one
 * transaction under the user's credential-setup lock, which every delete of
 * the user's links (a resend, a finished reset, an activation) also takes, so
 * none of them can slip in between.
 */
export async function recordResetLinkMailed(input: {
  token: string;
  userId: string;
  email: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return withLockSlot(() =>
    prisma.$transaction(async (tx) => {
      await lockCredentialSetup(tx, input.userId);
      const link = await tx.verification.findFirst({
        where: {
          identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${input.token}`,
          value: input.userId,
          expiresAt: { gt: now },
        },
        select: { expiresAt: true },
      });
      if (!link) return false;
      await tx.verification.create({
        data: {
          identifier: mailedIdentifier(input.token),
          value: JSON.stringify({ userId: input.userId, email: input.email.toLowerCase() }),
          expiresAt: link.expiresAt,
        },
        select: { id: true },
      });
      return true;
    }),
  );
}

/**
 * Whether Better-Auth may spend the reset link `token` (checked by the
 * `/reset-password` before-hook). A mailed link always may: the mail went to
 * the account's own address (forgot-password, a mailed invite). A link the
 * admin was shown may only while the user is still a pending invite
 * ({@link isInvitePending}); once the account is active (verified, signed in,
 * an IdP linked) it is refused and deleted. An unknown or expired token is
 * left to Better-Auth, which refuses it itself.
 *
 * This is early refusal before the revocation sweep. The authoritative check
 * runs again in admitResetSpend inside the password commit transaction.
 *
 * A forgot-password link whose "mailed" record failed to write
 * (sendResetPassword logs it) is refused for a verified account: fail
 * closed; the user requests another one.
 */
export async function isResetLinkRedeemable(
  token: string,
  { emailConfigured, now = new Date() }: { emailConfigured: boolean; now?: Date },
): Promise<boolean> {
  if (!emailConfigured) return true;
  const identifier = `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
  return withLockSlot(() =>
    prisma.$transaction(async (tx) => {
      const link = await tx.verification.findFirst({
        where: { identifier, expiresAt: { gt: now } },
        select: { value: true },
      });
      if (!link) return true;
      const userId = link.value;
      const mailedFor = async () => {
        const mailed = await tx.verification.findFirst({
          where: { identifier: mailedIdentifier(token), expiresAt: { gt: now } },
          select: { value: true },
        });
        return mailed !== null && parseMailed(mailed.value)?.userId === userId;
      };
      if (await mailedFor()) return true;
      await lockCredentialSetup(tx, userId);
      // Again under the lock: a record whose writer held the lock while we
      // waited has committed now, and must not be refused as "shown".
      if (await mailedFor()) return true;
      const state = await tx.user.findUnique({
        where: { id: userId },
        select: inviteStateSelect(now),
      });
      if (state && isInvitePending(state)) return true;
      await tx.verification.deleteMany({ where: { identifier, value: userId } });
      return false;
    }),
  );
}

function parseMailed(value: string): { userId: string; email: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId, email } = parsed as Record<string, unknown>;
    return typeof userId === "string" && typeof email === "string" ? { userId, email } : null;
  } catch {
    return null;
  }
}

/**
 * Authoritative admission at Better Auth's consumeOne seam, on the SAME
 * transaction/client as token consumption, session deletion and password write.
 * The caller holds password-write; user credentials precede this setup lock.
 * Mailbox verification and deletion of competing links commit with this
 * password, or all roll back. No after-hook can establish this property.
 */
export async function admitResetSpend(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "verification" | "user">,
  token: string,
  { emailConfigured, now = new Date() }: { emailConfigured: boolean; now?: Date },
): Promise<boolean> {
  const identifier = `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
  const first = await tx.verification.findFirst({ where: { identifier }, select: { value: true } });
  if (!first) return true; // Better Auth refuses the missing token.
  const userId = first.value;
  await lockCredentialSetup(tx, userId);
  const link = await tx.verification.findFirst({
    where: { identifier, value: userId, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (!link) return false;
  const mailed = await tx.verification.findFirst({
    where: { identifier: mailedIdentifier(token), expiresAt: { gt: now } },
    select: { value: true },
  });
  const target = mailed ? parseMailed(mailed.value) : null;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { ...inviteStateSelect(now), email: true },
  });
  const proved = target?.userId === userId && target.email === user?.email.toLowerCase();
  if (!user || (emailConfigured && !proved && !isInvitePending(user))) return false;
  await tx.verification.deleteMany({
    where: {
      value: userId,
      identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX, not: identifier },
    },
  });
  if (proved) {
    await tx.verification.deleteMany({ where: { identifier: mailedIdentifier(token) } });
    await tx.user.updateMany({
      where: { id: userId, email: user.email },
      data: { emailVerified: true },
    });
  }
  return true;
}

/**
 * The reset token a `POST /reset-password` request carries, or null. Better-Auth
 * reads it from the body or the query, so this does too.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
