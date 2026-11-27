import { randomBytes } from "node:crypto";
import { auth } from "@cockpit-context/auth";
import { announceUserBanned, isUserBanned, onUserBanned } from "@cockpit-context/auth/ban";
import { createSetPasswordToken } from "@cockpit-context/auth/invite-verification";
import {
  lockUserCredentials,
  oauthRevocationWrites,
  withUserCredentialTransaction,
} from "@cockpit-context/auth/oauth-revocation";
import {
  recordResetLinkMailed,
  withCredentialSetupLock,
} from "@cockpit-context/auth/password-reset-links";
import { isAdminRole } from "@cockpit-context/auth/roles";
import { invalidateSignupAvailabilityCache } from "@cockpit-context/auth/signup-availability";
import {
  registerUserDeletionCleanup,
  runWithAllowedUserCreation,
} from "@cockpit-context/auth/user-creation-policy";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from "@cockpit-context/config/locales";
import prisma, { type Prisma } from "@cockpit-context/db";
import { env } from "@cockpit-context/env/server";
import {
  isEmailConfigured,
  renderInviteUser,
  renderResetPassword,
  sendEmail,
} from "@cockpit-context/mailer";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure } from "../index";
import { recordAdminAudit } from "../lib/admin-audit";
import { withAdminRemovalGuard } from "../lib/admin-presence";
import {
  captureArchiveUndoCredentials,
  clearArchiveUndoRecords,
  restoreArchiveUndoCredentials,
  writeArchiveUndoRecord,
} from "../lib/archive-undo-credentials";
import { reasonError, withDomainErrors } from "../lib/domain-errors";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { prepareUserDeletion, stopUserRuns } from "../lib/user-deletion";

// Wire Better-Auth admin/remove-user through the same cleanup as users.remove.
registerUserDeletionCleanup(prepareUserDeletion);
// The admin plugin's `/admin/ban-user` and `/admin/update-user` ban through
// Better-Auth (announced by its update hook as `auth-plugin`) and stop
// nothing themselves: stop the user's runs here. `archive` and account
// removal await `stopUserRuns` directly.
onUserBanned((userId, origin) => {
  if (origin !== "auth-plugin") return;
  stopUserRuns(userId).catch((error: unknown) => {
    const label = error instanceof Error ? error.name : typeof error;
    console.error("[users] stopping a banned user's runs failed:", label);
  });
});

// Roles surfaced in the admin UI. Better-auth itself stores `role` as a free-
// form string (and supports comma-separated lists), but the admin dashboard
// only ever assigns one of these two — anything else came from custom code or
// a database edit and we leave it untouched.
const ASSIGNABLE_ROLES = ["user", "admin"] as const;
const assignableRoleSchema = z.enum(ASSIGNABLE_ROLES);

const userIdInput = z.object({ userId: z.string().min(1) });

const userStatusFilter = z.enum(["all", "active", "archived"]);

/**
 * The invited account's initial password: 32 random bytes that nobody ever
 * sees. It is never returned, emailed or logged, so no one (the inviting
 * admin included) can sign in with it; the invitee chooses their own password
 * through the one-time set-password link instead (docs/access-matrix.md: admins cannot act
 * as another user).
 */
function generateUnusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * How long an invite's set-password link stays usable. Longer than
 * Better-Auth's one-hour reset lifetime on purpose: an invitee may not open
 * the email (or the link the admin passed on) within the hour.
 */
const INVITE_LINK_TTL_DAYS = 7;
const INVITE_LINK_TTL_MS = INVITE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Mints a one-time link that lets `userId` choose their password, on the web
 * `/$lang/reset-password` page.
 *
 * It is Better-Auth's own password-reset token, not a second mechanism: the
 * same `reset-password:<token>` verification row (value = user id) that its
 * `requestPasswordReset` endpoint writes, through the same internal adapter.
 * Only the lifetime differs (`INVITE_LINK_TTL_MS` instead of
 * `resetPasswordTokenExpiresIn`): Better-Auth reads that setting only when it
 * *requests* a reset, and its `/reset-password` callback and `resetPassword`
 * endpoint check the stored row's `expiresAt` alone. `resetPassword` consumes
 * the row once (`consumeVerificationValue`) before writing the password.
 * Reset writes use a selective adapter transaction: a pre-commit password-write
 * failure rolls back token/proof changes, so the same link can be retried.
 * Consuming it needs no SMTP: Better-Auth requires `sendResetPassword` only
 * to request a token, which is why this mints it server-side instead. The
 * `reap-expired-auth-tokens` job deletes the row once `expiresAt` passes.
 *
 * `invite` marks the link as an invitation (the page then says "choose your
 * password" instead of "reset your password").
 */
async function mintSetPasswordLink(
  userId: string,
  locale: string,
  options: { invite: boolean },
): Promise<{ url: string; token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + INVITE_LINK_TTL_MS);
  const token = await withCredentialSetupLock(userId, async (tx) => {
    if (!options.invite)
      await tx.verification.deleteMany({
        where: { identifier: { startsWith: "reset-password:" }, value: userId },
      });
    return createSetPasswordToken(
      { createVerificationValue: (data) => tx.verification.create({ data, select: { id: true } }) },
      userId,
      expiresAt,
    );
  });
  // The web app lives on CORS_ORIGIN when it is split from this API.
  const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const url = new URL(`/${lang}/reset-password`, env.CORS_ORIGIN ?? env.BETTER_AUTH_URL);
  url.searchParams.set("token", token);
  if (options.invite) url.searchParams.set("invite", "1");
  return { url: url.toString(), token, expiresAt };
}

/**
 * Records that the link for `token` was mailed, after the mail was accepted.
 * Only a mailed link verifies the address when spent, and only a mailed link
 * stays spendable once the account is active
 * (@cockpit-context/auth/password-reset-links). The mail is already out, so a
 * failed record is logged, not surfaced: the link then counts as shown (it
 * still works for a pending invitee, who verifies by email at first sign-in).
 */
async function recordMailed(
  token: string,
  userId: string,
  email: string,
  source: string,
): Promise<void> {
  try {
    await recordResetLinkMailed({ token, userId, email });
  } catch (err) {
    const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    console.warn(`[${source}] recording the mailed link failed:`, errLabel);
  }
}

// No-queue delivery admission for `users.passwordLink` (not a DB setup lock).
// Reset never takes this gate; mint/cleanup serialize on lockCredentialSetup.
// In-process delivery admission is enough:
// Cockpit Context runs exactly one app replica (docs/hosting.md). A second
// request while one is in flight is refused at once rather than queued: each
// holds the request open for up to the mail budget, so a queue would add
// those waits up past a reverse proxy's idle limit (docs/deploy.md).
const passwordLinkDeliveriesInFlight = new Set<string>();

async function withPasswordLinkDelivery<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (passwordLinkDeliveriesInFlight.has(userId)) {
    throw reasonError(
      "CONFLICT",
      "PASSWORD_LINK_BUSY",
      "A password link for this user is still being sent. Try again in a moment.",
    );
  }
  passwordLinkDeliveriesInFlight.add(userId);
  try {
    return await fn();
  } finally {
    passwordLinkDeliveriesInFlight.delete(userId);
  }
}

// Per-procedure budgets: a batch can contain many mail actions. Charge before writes.
const consumeInviteMailBudget = createProcedureBudget({
  keyPrefix: "rl:users-invite-mail",
  points: 30,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many invitations. Try again in ${seconds}s.`,
  unavailableMessage: "Invitation delivery is temporarily unavailable.",
  unavailableLog: "[users] invite mail limiter unavailable, failing closed:",
});
const consumeResendInviteBudget = createProcedureBudget({
  keyPrefix: "rl:users-resend-invite",
  points: 5,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: (seconds) =>
    `Too many password links for this user. Try again in ${seconds}s.`,
  unavailableMessage: "Password link delivery is temporarily unavailable.",
  unavailableLog: "[users] password link limiter unavailable, failing closed:",
});

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  banned: true,
  banReason: true,
  banExpires: true,
  twoFactorEnabled: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const usersRouter = {
  list: adminOr404Procedure
    .input(
      cursorPageInput
        .extend({
          limit: z.number().int().min(1).max(100).default(50),
          search: z.string().trim().max(200).optional(),
          status: userStatusFilter.default("all"),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const cursor = input?.cursor;
      const search = input?.search;
      const status = input?.status ?? "all";
      // Status is filtered in the database, not on the client: filtering
      // already-paginated pages makes both the empty state and the "load more"
      // affordance lie (an all-archived first page under the "active" tab would
      // look empty even though later pages hold active users). `banned` is a
      // nullable Boolean, so "active" must match both `false` and NULL.
      const searchWhere: Prisma.UserWhereInput | undefined = search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" as const } },
              { name: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : undefined;
      const statusWhere: Prisma.UserWhereInput | undefined =
        status === "active"
          ? { OR: [{ banned: false }, { banned: null }] }
          : status === "archived"
            ? { banned: true }
            : undefined;
      // Narrowed (not just filtered): `withCursor` ANDs this into an array,
      // where an `undefined` union member would fail typecheck.
      const conditions = [statusWhere, searchWhere].filter(
        (c): c is Prisma.UserWhereInput => c !== undefined,
      );
      const where: Prisma.UserWhereInput =
        conditions.length > 1 ? { AND: conditions } : (conditions[0] ?? {});
      // Cursor (keyset) pagination: no `skip` scan, no per-page `count()`.
      // The admin UI consumes this as an infinite list (LoadMore), so the
      // header total is dropped — it cost a full filtered count per page for
      // a "showing N" nicety. Tie-break on the unique id: `createdAt` alone
      // is not a stable sort key, so two users created in the same
      // millisecond could repeat or vanish across pages.
      const rows = await prisma.user.findMany({
        // The status/search `where` stays the first `AND` member; the keyset
        // narrows it, it never replaces it.
        where: withCursor(where, "createdAt", cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(limit),
        select: USER_SELECT,
      });
      const page = cursorPage(rows, limit, "createdAt");
      return { users: page.items, nextCursor: page.nextCursor };
    }),

  invite: adminOr404Procedure
    .input(
      z.object({
        email: z.string().email().toLowerCase(),
        name: z.string().trim().min(1).max(100),
        role: assignableRoleSchema.default("user"),
        // The invitee's language: the invite email, the set-password page it
        // links to and every later email use it, and it is saved as their
        // `User.locale` (they can change it in settings). The admin UI
        // defaults it to the admin's own language.
        locale: z.enum(SUPPORTED_LOCALES),
      }),
    )
    .handler(async ({ input, context }) => {
      await consumeInviteMailBudget(context.session.user.id);
      // The account starts unverified, and the invite email is the only mail:
      // createUser sends no verification mail, and sign-in's resend
      // (`sendOnSignIn`) needs the correct password, which nobody has. Using
      // the emailed link proves the inbox and verifies the address then
      // (@cockpit-context/auth/password-reset-links), so an invite to a
      // mistyped address never yields a verified account.
      const initialPassword = generateUnusablePassword();

      // `auth.api.createUser` is the only admin-plugin endpoint that accepts
      // server-side calls without a session in headers (verified in the
      // better-auth source). It hashes the password, enforces email
      // uniqueness, and writes through the Prisma adapter so it stays in
      // sync with any custom databaseHooks (e.g. ADMIN_EMAILS auto-promote).
      let userId: string;
      const recipientLocale = input.locale;
      try {
        // The grant's locale seeds `User.locale` in the user-create hook
        // (packages/auth): a server-side createUser carries no locale header.
        const created = await runWithAllowedUserCreation(
          "admin-invite",
          () =>
            auth.api.createUser({
              body: {
                email: input.email,
                password: initialPassword,
                name: input.name,
                role: input.role,
              },
            }),
          { locale: input.locale },
        );
        userId = created.user.id;
        invalidateSignupAvailabilityCache();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to invite user";
        if (/already exists|already in use|duplicate/i.test(message)) {
          throw new ORPCError("CONFLICT", {
            message: "A user with that email already exists.",
          });
        }
        if (/sign-?up.*disabled|disabled.*sign-?up/i.test(message)) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Account creation is disabled by the auth configuration. Ask an admin to check the invite setup.",
          });
        }
        // Log only name+message — the generated password was just
        // passed to auth.api.createUser, so we don't dump the raw error
        // object in case a future better-auth release attaches request
        // context to thrown errors.
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.error("[users.invite] auth.api.createUser failed:", errLabel);
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message:
            "Couldn't create that account. Try again, or contact an admin if it keeps happening.",
        });
      }

      // One link, two ways to deliver it. A failure here leaves an account
      // nobody can sign in to, so say so: the admin deletes it and invites
      // again (a fresh invitee has no content, so the delete succeeds).
      let link: { url: string; token: string; expiresAt: Date };
      try {
        link = await mintSetPasswordLink(userId, recipientLocale, { invite: true });
      } catch (err) {
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.error("[users.invite] minting the set-password link failed:", errLabel);
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message:
            "The account was created, but its set-password link couldn't be made. Delete the user and invite them again.",
        });
      }

      // Email send is best-effort: if SMTP is not configured (or fails) the
      // link goes back to the admin instead, to share out of band. With a
      // sent email nothing secret is returned. The email failure is logged
      // but does not roll back the user creation — undoing it would race
      // against any concurrent admin who is already looking at the new row.
      let emailSent = false;
      if (isEmailConfigured()) {
        try {
          const { subject, html } = renderInviteUser({
            name: input.name,
            email: input.email,
            setPasswordUrl: link.url,
            linkExpiresInDays: INVITE_LINK_TTL_DAYS,
            locale: recipientLocale,
          });
          await sendEmail({ to: input.email, subject, html });
          emailSent = true;
        } catch (err) {
          const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
          console.warn("[users.invite] failed to send invite email:", errLabel);
        }
      }

      // Only an emailed link proves the invitee controls the address, so only
      // then does using it verify the email. A link the admin is shown sets the
      // password and verifies nothing: the invitee confirms their address by
      // email at first sign-in, and the link dies once the account is active.
      if (emailSent) await recordMailed(link.token, userId, input.email, "users.invite");

      if (emailSent) {
        return { userId, emailSent: true as const, setPasswordExpiresAt: link.expiresAt };
      }
      return {
        userId,
        emailSent: false as const,
        setPasswordUrl: link.url,
        setPasswordExpiresAt: link.expiresAt,
      };
    }),

  setRole: adminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: assignableRoleSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id && input.role !== "admin") {
        throw reasonError("FORBIDDEN", "SELF_DEMOTION", "You cannot remove your own admin role.");
      }
      const change = await withAdminRemovalGuard(
        input.userId,
        async (tx, target) => {
          if (target.role === input.role) return null;
          await tx.user.update({ where: { id: input.userId }, data: { role: input.role } });
          return { oldRole: target.role, newRole: input.role };
        },
        input.role,
      );
      if (change) {
        invalidateSignupAvailabilityCache();
        recordAdminAudit({
          action: "users.role_changed",
          actorUserId: context.session.user.id,
          targetUserId: input.userId,
          details: change,
        });
      }
      return { success: true };
    }),

  archive: adminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot archive your own account.",
        });
      }
      // Revoke the app's MCP tokens and OAuth grants with the archive, under
      // the same last-active-admin + user-credential lock transaction. Capturing
      // the exact newly-revoked connections lets the immediate toast Undo
      // restore them without resurrecting previously-revoked or reset-wiped credentials.
      const now = new Date();
      const undoToken = await withAdminRemovalGuard(input.userId, async (tx, target) => {
        await lockUserCredentials(tx, input.userId);
        const captured = isUserBanned(target)
          ? null
          : await captureArchiveUndoCredentials(tx, input.userId, now);
        await tx.user.update({
          where: { id: input.userId },
          data: { banned: true, banReason: input.reason ?? null, banExpires: null },
        });
        await tx.session.deleteMany({ where: { userId: input.userId } });
        await tx.mcpAgentToken.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        for (const write of oauthRevocationWrites({ userId: input.userId }, now, tx)) await write;
        if (!captured) {
          await clearArchiveUndoRecords(tx, input.userId);
          return undefined;
        }
        return writeArchiveUndoRecord(tx, input.userId, captured, now);
      });
      // After the commit: closes their open live streams (watch/activity),
      // which were admitted once and are not re-checked (lib/live-streams.ts).
      announceUserBanned(input.userId);
      await stopUserRuns(input.userId);
      return { success: true, undoToken };
    }),

  unarchive: adminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        undoToken: z.string().min(1).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const now = new Date();
      const restoredConnections = await withUserCredentialTransaction(input.userId, async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true },
        });
        if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

        // Without the matching one-time `undoToken` from the archive response
        // (i.e. row "Restore user"), lift the ban only and clear any pending undo
        // record so revoked MCP tokens and OAuth connections stay revoked.
        // With `undoToken`, fail closed if the undo record expired or was
        // superseded (password reset, deletion, prior restore) so Undo cannot
        // unban an account undergoing deletion or recovery.
        let restored = false;
        if (input.undoToken) {
          restored = await restoreArchiveUndoCredentials(tx, input.userId, input.undoToken, now);
          if (!restored) {
            throw reasonError(
              "CONFLICT",
              "USER_CHANGE_CONFLICT",
              "Archive undo expired or was superseded. Refresh the user list before restoring.",
            );
          }
        } else {
          await clearArchiveUndoRecords(tx, input.userId);
        }

        await tx.user.update({
          where: { id: input.userId },
          data: { banned: false, banReason: null, banExpires: null },
        });
        return restored;
      });
      return { success: true, restoredConnections };
    }),

  /**
   * A one-time set-password link for an existing account (a locked-out user
   * on a server without SMTP, where "forgot password" cannot send mail). The
   * invite mechanism: Better-Auth's own single-use reset token, bound to the
   * user id, valid `INVITE_LINK_TTL_DAYS`. Issuing one supersedes the user's
   * outstanding reset links. With SMTP the link is emailed to the user and
   * never shown to the admin; a failed send revokes it and fails. Without
   * SMTP it is returned once for the admin to pass on privately. Either way an
   * audit entry records who issued it for whom.
   *
   * Refused for administrators (demote first), archived accounts (unarchive
   * first) and accounts with no
   * password sign-in (SSO-only): Better-Auth's reset would CREATE a password
   * credential there, adding a sign-in path the account never had.
   */
  passwordLink: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "Change your own password from your account settings.",
      });
    }
    // One issuance per user at a time: superseding older links, minting the
    // new one and the delivery bookkeeping must not interleave with a second
    // request for the same user, or both links would stay live.
    await consumeInviteMailBudget(context.session.user.id);
    await consumeResendInviteBudget(input.userId);
    return withPasswordLinkDelivery(input.userId, async () => {
      const target = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, locale: true, banned: true, role: true },
      });
      if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });
      if (target.banned === true) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This user is archived. Unarchive them before sending a password link.",
        });
      }
      // An admin cannot set another admin's password: demote them first, which
      // is itself a visible action (docs/access-matrix.md).
      if (isAdminRole(target.role)) {
        throw reasonError(
          "FORBIDDEN",
          "PASSWORD_LINK_ADMIN_TARGET",
          "Administrators cannot receive a password link. Demote the account first.",
        );
      }
      const credential = await prisma.account.findFirst({
        where: { userId: target.id, providerId: "credential" },
        select: { id: true },
      });
      if (!credential) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This user signs in with SSO and has no password to set.",
        });
      }

      // One live link per user: drop earlier reset links (the value of a
      // `reset-password:` row is the user id). Whether a link verifies the
      // address is recorded per token, so no earlier record can carry over.
      const link = await mintSetPasswordLink(target.id, target.locale, { invite: false });

      if (!isEmailConfigured()) {
        // No SMTP: the admin is the only channel. The link is returned once.
        recordAdminAudit({
          action: "users.passwordLink",
          actorUserId: context.session.user.id,
          targetUserId: target.id,
          details: { delivery: "admin", expiresAt: link.expiresAt.toISOString() },
        });
        return {
          emailSent: false as const,
          setPasswordUrl: link.url,
          setPasswordExpiresAt: link.expiresAt,
        };
      }

      // With SMTP the link goes ONLY to the user's mailbox. A failed send
      // revokes it and fails: the admin never sees a live link here.
      try {
        const { subject, html } = renderResetPassword({ url: link.url, locale: target.locale });
        await sendEmail({ to: target.email, subject, html });
      } catch (err) {
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.warn("[users.passwordLink] failed to send the password link email:", errLabel);
        await prisma.verification.deleteMany({
          where: { identifier: `reset-password:${link.token}` },
        });
        recordAdminAudit({
          action: "users.passwordLink",
          actorUserId: context.session.user.id,
          targetUserId: target.id,
          details: { delivery: "failed" },
        });
        throw reasonError(
          "SERVICE_UNAVAILABLE",
          "PASSWORD_LINK_DELIVERY_FAILED",
          "The password link email could not be sent. No link was issued; try again later.",
        );
      }
      // As with an invite: only an emailed link proves the user controls the
      // address, and only it stays spendable for an active account.
      await recordMailed(link.token, target.id, target.email, "users.passwordLink");
      recordAdminAudit({
        action: "users.passwordLink",
        actorUserId: context.session.user.id,
        targetUserId: target.id,
        details: { delivery: "email", expiresAt: link.expiresAt.toISOString() },
      });
      return { emailSent: true as const, setPasswordExpiresAt: link.expiresAt };
    });
  }),

  remove: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot delete your own account.",
      });
    }
    // prepareUserDeletion guards and commits the access-removing ban before
    // repository cleanup, which can wait on external locks outside the transaction.
    // REPOSITORY_BUSY (a clone or fetch of theirs outlasted the bounded lock
    // wait) reaches the admin as "try again": the account stays banned.
    await withDomainErrors(() => prepareUserDeletion(input.userId));
    // Recheck after cleanup too: another admin may have restored this user
    // while external repository locks were being drained.
    await withAdminRemovalGuard(input.userId, async (tx) => {
      await tx.user.delete({ where: { id: input.userId } });
    });
    invalidateSignupAvailabilityCache();
    return { success: true };
  }),
};
