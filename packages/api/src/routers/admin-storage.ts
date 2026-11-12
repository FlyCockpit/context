import prisma, { type Prisma } from "@cockpit-context/db";
import { enqueueJob } from "@cockpit-context/jobs";
import {
  deleteCheckout,
  deleteRepository,
  maxStorageBytes,
  totalStorageBytes,
} from "@cockpit-context/repos";
import { pruneStorageJob } from "@cockpit-context/repos/jobs";
import { z } from "zod";

import { adminOr404Procedure } from "../index";
import { withDomainErrors } from "../lib/domain-errors";
import { lower } from "../lib/packages";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId } from "../lib/schemas";

/**
 * Storage across every repository (docs/product.md). Admins
 * see each clone's URL, size, last use and, for a private clone, its owner's
 * email — and nothing of anyone's packages, notes, conversations or keys
 * (docs/access-matrix.md). 404-hidden like the rest of /admin.
 */

/** Checkouts shown per repository row; the admin table expands a row to these. */
const CHECKOUTS_PER_REPOSITORY = 50;

function repositorySelect(now: Date) {
  return {
    id: true,
    createdAt: true,
    remoteUrl: true,
    visibility: true,
    status: true,
    isSnapshot: true,
    diskBytes: true,
    lastUsedAt: true,
    lastFetchedAt: true,
    Owner: { select: { email: true } },
    _count: { select: { Checkouts: true, Packages: true } },
    Checkouts: {
      orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: CHECKOUTS_PER_REPOSITORY,
      select: {
        id: true,
        sha: true,
        resolvedFrom: true,
        status: true,
        diskBytes: true,
        lastUsedAt: true,
        Leases: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
      },
    },
  } satisfies Prisma.RepositorySelect;
}

type RepositoryRow = Prisma.RepositoryGetPayload<{ select: ReturnType<typeof repositorySelect> }>;

function serializeRepository(row: RepositoryRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    remoteUrl: row.remoteUrl,
    visibility: lower(row.visibility),
    /** Private clones only; public clones are shared and have no owner. */
    ownerEmail: row.visibility === "PRIVATE" ? (row.Owner?.email ?? null) : null,
    status: lower(row.status),
    isSnapshot: row.isSnapshot,
    diskBytes: Number(row.diskBytes),
    lastUsedAt: row.lastUsedAt,
    lastFetchedAt: row.lastFetchedAt,
    checkoutCount: row._count.Checkouts,
    packageCount: row._count.Packages,
    checkouts: row.Checkouts.map((checkout) => ({
      id: checkout.id,
      sha: checkout.sha,
      resolvedFrom: checkout.resolvedFrom,
      status: lower(checkout.status),
      diskBytes: Number(checkout.diskBytes),
      lastUsedAt: checkout.lastUsedAt,
      leased: checkout.Leases.length > 0,
    })),
  };
}

export const adminStorageRouter = {
  list: adminOr404Procedure.input(cursorPageInput).handler(async ({ input }) => {
    const now = new Date();
    const [rows, totalBytes, snapshots] = await Promise.all([
      prisma.repository.findMany({
        where: withCursor({}, "createdAt", input.cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(input.limit),
        select: repositorySelect(now),
      }),
      totalStorageBytes(),
      prisma.repository.aggregate({ where: { isSnapshot: true }, _sum: { diskBytes: true } }),
    ]);
    const page = cursorPage(rows, input.limit, "createdAt");
    return {
      items: page.items.map(serializeRepository),
      nextCursor: page.nextCursor,
      totalBytes: Number(totalBytes),
      capBytes: Number(maxStorageBytes()),
      snapshotBytes: Number(snapshots._sum.diskBytes ?? 0n),
    };
  }),

  /**
   * Delete a checkout or a whole clone. A leased one is refused
   * (CONFLICT / CHECKOUT_LEASED) unless `force`, which pulls it out from under
   * the run reading it (that run then ends `failed` / `checkout-failed`).
   */
  delete: adminOr404Procedure
    .input(
      z.object({
        kind: z.enum(["checkout", "repository"]),
        id: entityId,
        force: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const { freedBytes } = await withDomainErrors(() =>
        input.kind === "checkout"
          ? deleteCheckout(input.id, { force: input.force })
          : deleteRepository(input.id, { force: input.force }),
      );
      return { freedBytes: Number(freedBytes) };
    }),

  /** Queue a measuring prune pass now (`storage.prune`, reason `manual`). */
  prune: adminOr404Procedure.handler(async () => {
    const { id } = await enqueueJob(pruneStorageJob, { reason: "manual", measure: true });
    return { jobId: id };
  }),
};
