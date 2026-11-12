import prisma from "@cockpit-context/db";
import { deleteRepository } from "@cockpit-context/repos";
import { getRunEngine } from "@cockpit-context/runs";
import { invalidateAnswersForOwner } from "@cockpit-context/runs/answer-reuse";
import { forEachPage, keysetWhere } from "./pagination";

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

/** Called before either oRPC or Better-Auth cascades the user's rows. */
export async function prepareUserDeletion(userId: string): Promise<void> {
  // Block new authenticated work before stopping existing work and removing files.
  await prisma.user.update({ where: { id: userId }, data: { banned: true, banExpires: null } });
  await prisma.session.deleteMany({ where: { userId } });
  await stopUserRuns(userId);
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
      for (const row of rows) await deleteRepository(row.id, { force: true });
    },
  );
}
