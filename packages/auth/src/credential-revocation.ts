import { randomBytes } from "node:crypto";
import prisma from "@cockpit-context/db";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { announceUserSessionsRevoked } from "./ban.js";
import { withLockSlot } from "./lock-slots.js";
import { revokeUserCredentials } from "./oauth-revocation.js";

/** Same issuance lock and live-session checks as identity-cache2, for both reset sweeps. */
export async function revokeCredentialsBeforePasswordReset(ctx: {
  path?: string;
  body?: { token?: unknown };
  query?: { token?: unknown };
  context: {
    internalAdapter: {
      findVerificationValue: (id: string) => Promise<{ value: string; expiresAt: Date } | null>;
    };
  };
}): Promise<void> {
  if (ctx.path !== "/reset-password") return;
  const token = ctx.body?.token || ctx.query?.token;
  if (typeof token !== "string" || !token) return;
  let userId: string | undefined;
  try {
    const row = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
    if (row && !(row.expiresAt < new Date())) {
      userId = row.value;
      await revokeUserCredentials(row.value, { revokeSessions: true });
    }
  } catch (error) {
    console.error(
      "SECURITY password-reset preflight failed",
      userId ?? "unknown",
      error instanceof Error ? error.name : typeof error,
    );
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
  }
}

export function revokeCredentialsAfterPasswordReset(userId: string): Promise<void> {
  return revokeUserCredentials(userId, { revokeSessions: true });
}

/** Only the token the change issued survives its final sweep. */
export function revokeCredentialsAfterPasswordChange({
  userId,
  keepSessionToken,
}: PasswordChangeRevocationTarget): Promise<void> {
  return revokeUserCredentials(userId, { revokeSessions: true, keepSessionToken });
}

/** Scramble first, then sweep: the fingerprint fence closes either ordering of a delayed sign-in. */
export async function quarantineUntrustedPasswordWrite(
  userId: string,
  { hash = hashPassword }: { hash?: (password: string) => Promise<string> } = {},
): Promise<void> {
  const unusable = await hash(randomBytes(32).toString("base64url"));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withLockSlot(() =>
        prisma.$transaction([
          prisma.account.updateMany({
            where: { userId, providerId: "credential" },
            data: { password: unusable },
          }),
        ]),
      );
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
  try {
    await revokeUserCredentials(userId, { revokeSessions: true });
  } finally {
    // The final committed deletion prevents new admission; close every stream
    // registered while it was in flight, even when cleanup ultimately failed.
    announceUserSessionsRevoked(userId);
  }
}

/** Who a finished password change revokes, and the session it keeps. */
export type PasswordChangeRevocationTarget = { userId: string; keepSessionToken: string };

const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * The user whose MCP credentials (and other sessions) a finished Better-Auth
 * request should revoke, with the session token the change issued to keep, or
 * `null`. Only a *successful* `/change-password` that asked to sign out
 * other sessions (`revokeOtherSessions: true`, which the web settings form
 * always sends) qualifies: a change that keeps other sessions alive is the
 * user saying the old password did not leak.
 *
 * `returned` is the endpoint's result as an after-hook sees it: the JSON body
 * (`{ token, user }`) on success, an `APIError` on failure — which has no
 * `user`, so a rejected change never revokes anything. A success with
 * `revokeOtherSessions` always carries the new session's token.
 */
export function passwordChangeRevocationTarget(ctx: {
  path?: string;
  body?: unknown;
  returned?: unknown;
}): PasswordChangeRevocationTarget | null {
  if (ctx.path !== CHANGE_PASSWORD_PATH) return null;
  if (!isRecord(ctx.body) || ctx.body.revokeOtherSessions !== true) return null;
  if (!isRecord(ctx.returned) || !isRecord(ctx.returned.user)) return null;
  const id = ctx.returned.user.id;
  const token = ctx.returned.token;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { userId: id, keepSessionToken: token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
