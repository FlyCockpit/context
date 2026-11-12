import { randomBytes } from "node:crypto";
import prisma from "@cockpit-context/db";

/** The slice of Better-Auth's `internalAdapter` a set-password token needs. */
export interface VerificationValueWriter {
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
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
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt,
  });
  return token;
}

/**
 * An emailed admin invite counts as email verification. The invitee can only
 * choose a password through the one-time set-password link, so consuming a
 * link that was *emailed* proves they control the address.
 *
 * A link the admin was handed instead (SMTP off, or the send failed) proves
 * nothing about the mailbox. So `users.invite` writes this marker only after
 * the invite email was accepted for delivery, and the Better-Auth
 * `onPasswordReset` hook marks the address verified only when the marker is
 * present. The marker is keyed by user and bound to the invited address, and
 * it expires with the link. The `reap-expired-auth-tokens` job deletes it
 * after that, like any other verification row.
 *
 * Every other reset token for the user comes from `requestPasswordReset`, which
 * also emails it, or from the admin's `users.passwordLink`, which clears the
 * marker first and re-records it only when it emailed the link. So the marker
 * can't be redeemed through a link that wasn't emailed.
 */
const INVITE_DELIVERED_PREFIX = "invite-email-delivered:";

function markerIdentifier(userId: string): string {
  return `${INVITE_DELIVERED_PREFIX}${userId}`;
}

export async function recordInviteEmailDelivered(input: {
  userId: string;
  email: string;
  expiresAt: Date;
}): Promise<void> {
  await prisma.verification.create({
    data: {
      identifier: markerIdentifier(input.userId),
      value: input.email.toLowerCase(),
      expiresAt: input.expiresAt,
    },
  });
}

/**
 * Drop the user's marker. `users.passwordLink` calls it before minting a link
 * the admin may be handed: otherwise consuming that un-emailed link would
 * redeem an earlier invite's marker and verify an address nobody proved.
 */
export async function clearInviteEmailDelivered(userId: string): Promise<void> {
  await prisma.verification.deleteMany({ where: { identifier: markerIdentifier(userId) } });
}

/**
 * Called from `emailAndPassword.onPasswordReset`, after Better-Auth has
 * committed the new password. Consumes the marker and sets `emailVerified` in
 * one transaction. Returns whether the address was verified.
 */
export async function verifyInvitedEmailOnPasswordReset(user: {
  id: string;
  email: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const consumed = await tx.verification.deleteMany({
      where: {
        identifier: markerIdentifier(user.id),
        value: user.email.toLowerCase(),
        expiresAt: { gt: new Date() },
      },
    });
    if (consumed.count === 0) return false;
    await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    return true;
  });
}
