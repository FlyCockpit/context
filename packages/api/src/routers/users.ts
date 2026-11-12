import { randomBytes } from "node:crypto";
import { auth } from "@cockpit-context/auth";
import {
  clearInviteEmailDelivered,
  createSetPasswordToken,
  recordInviteEmailDelivered,
} from "@cockpit-context/auth/invite-verification";
import { isAdminRole } from "@cockpit-context/auth/roles";
import { invalidateSignupAvailabilityCache } from "@cockpit-context/auth/signup-availability";
import {
  registerUserDeletionCleanup,
  runWithAllowedUserCreation,
} from "@cockpit-context/auth/user-creation-policy";
import { DEFAULT_LOCALE, isSupportedLocale } from "@cockpit-context/config/locales";
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
import { reasonError } from "../lib/domain-errors";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { prepareUserDeletion, stopUserRuns } from "../lib/user-deletion";
import { oauthRevocationWrites } from "./mcp-connections";

// Wire Better-Auth admin/remove-user through the same cleanup as users.remove.
registerUserDeletionCleanup(prepareUserDeletion);

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
 * the row atomically (`consumeVerificationValue`) in the transaction that
 * writes the password, so the link works once and then never again.
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
  const ctx = await auth.$context;
  const expiresAt = new Date(Date.now() + INVITE_LINK_TTL_MS);
  const token = await createSetPasswordToken(ctx.internalAdapter, userId, expiresAt);
  // The web app lives on CORS_ORIGIN when it is split from this API.
  const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const url = new URL(`/${lang}/reset-password`, env.CORS_ORIGIN ?? env.BETTER_AUTH_URL);
  url.searchParams.set("token", token);
  if (options.invite) url.searchParams.set("invite", "1");
  return { url: url.toString(), token, expiresAt };
}

// Per-user issuance queue for `users.passwordLink`. In-process is enough:
// Cockpit Context runs exactly one app replica (docs/hosting.md).
const passwordLinkTails = new Map<string, Promise<unknown>>();

async function withPasswordLinkLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = passwordLinkTails.get(userId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  passwordLinkTails.set(userId, tail);
  try {
    return await run;
  } finally {
    if (passwordLinkTails.get(userId) === tail) passwordLinkTails.delete(userId);
  }
}

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
      }),
    )
    .handler(async ({ input }) => {
      const initialPassword = generateUnusablePassword();

      // `auth.api.createUser` is the only admin-plugin endpoint that accepts
      // server-side calls without a session in headers (verified in the
      // better-auth source). It hashes the password, enforces email
      // uniqueness, and writes through the Prisma adapter so it stays in
      // sync with any custom databaseHooks (e.g. ADMIN_EMAILS auto-promote).
      let userId: string;
      let recipientLocale: string;
      try {
        const created = await runWithAllowedUserCreation("admin-invite", () =>
          auth.api.createUser({
            body: {
              email: input.email,
              password: initialPassword,
              name: input.name,
              role: input.role,
            },
          }),
        );
        userId = created.user.id;
        invalidateSignupAvailabilityCache();
        // The User row was just created with the Prisma `@default("en-US")`
        // for `locale`. Read it back so a future change to the default (or a
        // hook that overrides it) flows through to the email render without
        // additional plumbing here.
        const fresh = await prisma.user.findUnique({
          where: { id: userId },
          select: { locale: true },
        });
        recipientLocale = fresh?.locale ?? "en-US";
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
      let link: { url: string; expiresAt: Date };
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
      // then does using it verify the email (@cockpit-context/auth/invite-verification).
      // If this write fails the invite still works; the invitee just verifies
      // through the normal email after choosing a password.
      if (emailSent) {
        try {
          await recordInviteEmailDelivered({
            userId,
            email: input.email,
            expiresAt: link.expiresAt,
          });
        } catch (err) {
          const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
          console.warn("[users.invite] recording the emailed invite failed:", errLabel);
        }
      }

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
      // Don't let an admin demote themselves — if they're the only admin
      // they'd lock themselves (and everyone) out of /admin.
      if (input.userId === context.session.user.id && input.role !== "admin") {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot remove your own admin role.",
        });
      }
      const target = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

      await prisma.user.update({
        where: { id: input.userId },
        data: { role: input.role },
      });
      invalidateSignupAvailabilityCache();
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
      const target = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

      // Set banned=true so better-auth treats the user as locked, and revoke
      // every active session so the next page-load signs them out. We mirror
      // what the admin plugin's banUser endpoint does internally — no expiry
      // (banExpires=null), no auto-unban.
      //
      // Standing credentials that authenticate from their own row are
      // revoked in the same transaction, because deleting sessions does not
      // touch them and they would otherwise outlive the ban everywhere a
      // per-surface ban re-check does not reach: every MCP API token, and
      // every OAuth MCP connection (grant tombstoned; access tokens, refresh
      // tokens and consent deleted, as `mcpConnections.revoke` does).
      // `unarchive` does not restore any of them. If you add another such
      // credential (an API key, a personal access token), revoke it here too.
      const now = new Date();
      await prisma.$transaction([
        prisma.user.update({
          where: { id: input.userId },
          data: {
            banned: true,
            banReason: input.reason ?? null,
            banExpires: null,
          },
        }),
        prisma.session.deleteMany({ where: { userId: input.userId } }),
        prisma.mcpAgentToken.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data: { revokedAt: now },
        }),
        ...oauthRevocationWrites({ userId: input.userId }, now),
      ]);
      await stopUserRuns(input.userId);
      return { success: true };
    }),

  unarchive: adminOr404Procedure.input(userIdInput).handler(async ({ input }) => {
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    // Lifts the ban only. The MCP tokens and OAuth connections `archive`
    // revoked stay revoked (OAuth tokens and consent were deleted outright):
    // the user signs in again and creates new ones. Do NOT flip them back on
    // from here: a row records that a credential IS revoked, not who revoked
    // it, so a blanket re-enable would also resurrect one the user or an
    // admin had deliberately killed earlier (a leaked token, a decommissioned
    // integration). Restoring precisely needs a column recording that archive
    // was the revoker.
    await prisma.user.update({
      where: { id: input.userId },
      data: { banned: false, banReason: null, banExpires: null },
    });
    return { success: true };
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
    return withPasswordLinkLock(input.userId, async () => {
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
      // `reset-password:` row is the user id) and the emailed-invite marker, so
      // an un-emailed link can never redeem an older emailed invite's verification.
      await prisma.verification.deleteMany({
        where: { identifier: { startsWith: "reset-password:" }, value: target.id },
      });
      await clearInviteEmailDelivered(target.id);
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
      // As with an invite: only an emailed link proves the user controls the address.
      try {
        await recordInviteEmailDelivered({
          userId: target.id,
          email: target.email,
          expiresAt: link.expiresAt,
        });
      } catch (err) {
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.warn("[users.passwordLink] recording the emailed link failed:", errLabel);
      }
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
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    await prepareUserDeletion(input.userId);
    await prisma.user.delete({ where: { id: input.userId } });
    invalidateSignupAvailabilityCache();
    return { success: true };
  }),
};
