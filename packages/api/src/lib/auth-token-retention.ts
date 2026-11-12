import prisma from "@cockpit-context/db";

const AUTH_TOKEN_SWEEP_PAGE = 1000;

/**
 * The slice of a Prisma delegate the sweep needs: select a bounded id page of
 * expired rows, then delete exactly those ids. Declaring it locally keeps the
 * sweep generic over the credential models without hauling their full
 * delegate generics into every call site.
 */
type ExpiredTokenDelegate = {
  findMany(args: {
    where: { expiresAt: { lt: Date } };
    select: { id: true };
    orderBy: { expiresAt: "asc" };
    take: number;
  }): Promise<Array<{ id: string }>>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
};

export type ReapedAuthTokens = {
  sessions: number;
  verifications: number;
};

/**
 * Delete one model's rows past `expiresAt`, a page at a time.
 *
 * `deleteMany` has no `take`, so we
 * select a bounded id page and delete by `id IN (…)` until a short page. Each
 * page's delete shrinks the next `findMany`'s result, so the loop advances even
 * without a cursor.
 */
async function sweepExpiredTokens(delegate: ExpiredTokenDelegate, now: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await delegate.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: AUTH_TOKEN_SWEEP_PAGE,
    });
    if (rows.length === 0) break;
    const result = await delegate.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    if (result.count === 0) break;
    deleted += result.count;
    if (rows.length < AUTH_TOKEN_SWEEP_PAGE) break;
  }
  return deleted;
}

export async function reapExpiredAuthTokens(
  now: Date = new Date(),
): Promise<{ deleted: ReapedAuthTokens }> {
  const sessions = await sweepExpiredTokens(prisma.session, now);
  const verifications = await sweepExpiredTokens(prisma.verification, now);
  return { deleted: { sessions, verifications } };
}
