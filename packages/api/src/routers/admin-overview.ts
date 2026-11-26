import { isSignupOpen } from "@cockpit-context/auth/signup-availability";
import prisma from "@cockpit-context/db";
import { maxStorageBytes, totalStorageBytes } from "@cockpit-context/repos";

import { adminOr404Procedure } from "../index";

/**
 * One live figure per admin overview card (docs/product.md): counts and sums
 * only — no rows, emails or URLs — so the overview discloses nothing the
 * Users, Storage, Jobs and Settings pages do not already show an admin.
 * 404-hidden like the rest of /admin.
 */
export const adminOverviewRouter = {
  stats: adminOr404Procedure.handler(async () => {
    const [activeUsers, archivedUsers, totalBytes, failedJobs, signupOpen] = await Promise.all([
      // Same split as the Users page's `active` / `archived` filters (users.list).
      prisma.user.count({ where: { OR: [{ banned: false }, { banned: null }] } }),
      prisma.user.count({ where: { banned: true } }),
      // The recorded clone and checkout sizes the Storage page totals; no disk walk.
      totalStorageBytes(),
      // The Jobs page's `failed` filter: every failed row it can list.
      prisma.backgroundJob.count({ where: { status: "failed" } }),
      // Effective sign-up (SIGNUP_ENABLED AND the admin toggle), cached in-process.
      isSignupOpen(),
    ]);
    return {
      users: { active: activeUsers, archived: archivedUsers },
      storage: { totalBytes: Number(totalBytes), capBytes: Number(maxStorageBytes()) },
      jobs: { failed: failedJobs },
      settings: { signupOpen },
    };
  }),
};
