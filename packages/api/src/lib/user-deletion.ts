import { announceUserBanned } from "@cockpit-context/auth/ban";
import prisma from "@cockpit-context/db";
import { deleteRepository, REQUEST_LOCK_WAIT_MS, RepoError } from "@cockpit-context/repos";
import { getRunEngine } from "@cockpit-context/runs";
import { invalidateAnswersForOwner } from "@cockpit-context/runs/answer-reuse";
import { forEachPage, keysetWhere } from "./pagination";
import { cancelSnapshotSyncs } from "./snapshot-tasks";

/**
 * Stop every run the user has, main AND summary, queued or running. Call it
 * after the account is blocked (banned, sessions and credentials revoked): the
 * engine then also refuses any run whose launch is still in flight, and any
 * queued summary job of theirs never starts. Their reusable MCP answers are
 * dropped too (docs/mcp.md § Answer reuse).
 */
export async function stopUserRuns(ownerId: string): Promise<void> {
  await getRunEngine().stopAllForOwner(ownerId);
  invalidateAnswersForOwner(ownerId);
}

/**
 * All the repository-lock waits of one account deletion together: well inside
 * a reverse proxy's idle limit (Cloudflare: 100 s, docs/deploy.md).
 */
const USER_DELETION_LOCK_BUDGET_MS = 30_000;

function busy(): RepoError {
  return new RepoError(
    "REPOSITORY_BUSY",
    "A clone or fetch of this user's repositories outlasted the deletion's lock budget.",
  );
}

/** Called before either oRPC or Better-Auth cascades the user's rows. */
export async function prepareUserDeletion(userId: string): Promise<void> {
  // Block new authenticated work before stopping existing work and removing files.
  // The ban and the session deletion commit together, and the ban is announced
  // (closing open live streams and MCP exchanges) right after the commit: a
  // failing deletion can no longer leave a committed ban unannounced.
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { banned: true, banExpires: null } }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
  announceUserBanned(userId);
  await stopUserRuns(userId);
  const deadline = Date.now() + USER_DELETION_LOCK_BUDGET_MS;
  await forEachPage(
    ({ take, afterId }) =>
      prisma.repository.findMany({
        where: { ownerId: userId, visibility: "PRIVATE", ...keysetWhere(afterId) },
        orderBy: { id: "asc" },
        take,
        select: { id: true },
      }),
    100,
    async (rows) => {
      // Their runs are stopped above; their snapshot clones are killed here.
      // The deletes share ONE lock-wait budget (then REPOSITORY_BUSY: the
      // account stays banned and the delete can be retried), so the request
      // never waits out long clones or fetches, however many repositories.
      cancelSnapshotSyncs(rows.map((row) => row.id));
      for (const row of rows) {
        const left = deadline - Date.now();
        if (left <= 0) throw busy();
        await deleteRepository(row.id, {
          force: true,
          lockWaitMs: Math.min(left, REQUEST_LOCK_WAIT_MS),
        });
      }
    },
  );
}
