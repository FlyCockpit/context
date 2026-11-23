import prisma, { type Prisma } from "@cockpit-context/db";
import { enqueueJob } from "@cockpit-context/jobs";
import {
  createSnapshotRepositoryRow,
  deleteRepository,
  importSshKey,
  lookupRegistry,
  normalizeImportedPrivateKey,
  REQUEST_LOCK_WAIT_MS,
  safeSnapshotError,
  snapshotRefMissing,
  toStoredEcosystem,
  validateRemoteUrl,
} from "@cockpit-context/repos";
import { fetchRepositoryJob } from "@cockpit-context/repos/jobs";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError, withDomainErrors } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import {
  consumePackageWriteBudget,
  consumeRegistryLookupBudget,
  createPackageForOwner,
  ecosystemSchema,
  forgetPackageReuse,
  gitUrlSchema,
  lower,
  normalizeNameOrThrow,
  packageFieldsSchema,
  packageViewSelect,
  refSchema,
  serializePackage,
  subdirectorySchema,
  tagPatternSchema,
  validatePackageSource,
} from "../lib/packages";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId, longText, shortText } from "../lib/schemas";
import {
  cancelSnapshotSync,
  type SnapshotSyncKind,
  startSnapshotSync,
  withSnapshotPackageGate,
  withSnapshotTasksClosed,
} from "../lib/snapshot-tasks";
import { consumeKeyWriteBudget, pastedSshKeySchema } from "../lib/ssh-key-input";

/**
 * Packages (docs/product.md): one user's dependency list. Every
 * query is scoped by `ownerId = session.user.id`; a foreign id is NOT_FOUND.
 * Admins get no wider view here (docs/access-matrix.md).
 */

const RECENT_CHECKOUTS = 5;

const recentCheckoutsSelect = {
  select: { id: true, sha: true, resolvedFrom: true, status: true, lastUsedAt: true },
  orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
  take: RECENT_CHECKOUTS,
} satisfies Prisma.Repository$CheckoutsArgs;

const packageListSelect = {
  ...packageViewSelect,
  Repository: {
    select: {
      ...packageViewSelect.Repository.select,
      Checkouts: recentCheckoutsSelect,
      _count: { select: { Checkouts: true } },
    },
  },
} satisfies Prisma.PackageSelect;

type PackageListRow = Prisma.PackageGetPayload<{ select: typeof packageListSelect }>;

function serializeRecentCheckouts(row: PackageListRow) {
  return {
    checkoutCount: row.Repository?._count.Checkouts ?? 0,
    recentCheckouts: (row.Repository?.Checkouts ?? []).map((checkout) => ({
      id: checkout.id,
      sha: checkout.sha,
      resolvedFrom: checkout.resolvedFrom,
      status: lower(checkout.status),
      lastUsedAt: checkout.lastUsedAt,
    })),
  };
}

const packageDetailSelect = {
  ...packageListSelect,
  notes: true,
} satisfies Prisma.PackageSelect;

function ownerOf(context: { session: { user: { id: string } } }) {
  return { field: "ownerId", id: context.session.user.id };
}

export const packagesRouter = {
  list: protectedProcedure
    .input(
      cursorPageInput.extend({
        ecosystem: ecosystemSchema.optional(),
        search: shortText.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const where: Prisma.PackageWhereInput = {
        ownerId: context.session.user.id,
        ...(input.ecosystem ? { ecosystem: toStoredEcosystem(input.ecosystem) } : {}),
        ...(input.search
          ? {
              OR: [
                { identifier: { contains: input.search, mode: "insensitive" } },
                { displayName: { contains: input.search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const rows = await prisma.package.findMany({
        where: withCursor(where, "createdAt", input.cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(input.limit),
        select: packageListSelect,
      });
      const page = cursorPage(rows, input.limit, "createdAt");
      return {
        items: page.items.map((row) => ({
          ...serializePackage(row),
          ...serializeRecentCheckouts(row),
        })),
        nextCursor: page.nextCursor,
      };
    }),

  get: protectedProcedure.input(z.object({ id: entityId })).handler(async ({ input, context }) => {
    const row = await findOwnedOrThrow({
      find: (args) => prisma.package.findFirst(args),
      args: { where: { id: input.id }, select: packageDetailSelect },
      owner: ownerOf(context),
      notFound: "Package not found.",
    });
    return { ...serializePackage(row), ...serializeRecentCheckouts(row), notes: row.notes };
  }),

  create: protectedProcedure
    .input(packageFieldsSchema.extend({ ecosystem: ecosystemSchema, name: shortText }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      normalizeNameOrThrow(input.ecosystem, input.name);
      await consumePackageWriteBudget(`user:${ownerId}`);
      const row = await createPackageForOwner(ownerId, input);
      return serializePackage(row);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: entityId,
        displayName: shortText.optional(),
        gitUrl: gitUrlSchema.optional(),
        sshKeyId: entityId.nullish(),
        subdirectory: subdirectorySchema.nullish(),
        tagPattern: tagPatternSchema.nullish(),
        defaultRef: refSchema.nullish(),
        notes: longText.nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const current = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: {
          where: { id: input.id },
          select: { id: true, gitUrl: true, sshKeyId: true, isSnapshot: true, repositoryId: true },
        },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      const data: Prisma.PackageUncheckedUpdateManyInput = {};
      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (input.subdirectory !== undefined) data.subdirectory = input.subdirectory;
      if (input.tagPattern !== undefined) data.tagPattern = input.tagPattern;
      if (input.defaultRef !== undefined) data.defaultRef = input.defaultRef;
      if (input.notes !== undefined) data.notes = input.notes;
      if (
        (input.gitUrl !== undefined && input.gitUrl !== current.gitUrl) ||
        (input.sshKeyId !== undefined && input.sshKeyId !== current.sshKeyId)
      ) {
        await consumePackageWriteBudget(`user:${ownerId}`);
        const source = await validatePackageSource(ownerId, {
          gitUrl: input.gitUrl ?? current.gitUrl,
          sshKeyId: input.sshKeyId === undefined ? current.sshKeyId : input.sshKeyId,
        });
        data.gitUrl = source.gitUrl;
        data.sshKeyId = source.sshKeyId;
        data.isSnapshot = false;
        // A different remote (or key) is a different repository row; the
        // next resolution links the right one.
        if (source.gitUrl !== current.gitUrl || source.sshKeyId !== current.sshKeyId) {
          data.repositoryId = null;
        }
      }
      const write = async (
        db: Prisma.TransactionClient | typeof prisma,
        repositoryId = current.repositoryId,
      ) => {
        const { count } = await db.package.updateMany({ where: { id: current.id, ownerId }, data });
        if (count === 0) throw reasonError("NOT_FOUND", "PACKAGE_NOT_FOUND", "Package not found.");
        if (current.isSnapshot && repositoryId && data.isSnapshot === false) {
          await db.repository.updateMany({
            where: { id: repositoryId, ownerId, isSnapshot: true },
            data: {
              isSnapshot: false,
              sshKeyId: typeof data.sshKeyId === "string" ? data.sshKeyId : null,
              snapshotSyncStatus: "NONE",
              snapshotSyncError: null,
            },
          });
        }
      };
      if (current.isSnapshot && data.isSnapshot === false) {
        // No pasted-key task may go on (or start) for a package that is no
        // longer a snapshot: serialized with re-keys, on the repository the
        // package has now (a concurrent re-key may have attached a new one).
        // A wait past PACKAGE_GATE_WAIT_MS answers CONFLICT / REPOSITORY_BUSY.
        await withDomainErrors(() =>
          withSnapshotPackageGate(current.id, async () => {
            const fresh = await prisma.package.findFirst({
              where: { id: current.id, ownerId },
              select: { repositoryId: true },
            });
            if (!fresh) throw reasonError("NOT_FOUND", "PACKAGE_NOT_FOUND", "Package not found.");
            await withSnapshotTasksClosed(fresh.repositoryId, () =>
              prisma.$transaction((tx) => write(tx, fresh.repositoryId)),
            );
          }),
        );
      } else await write(prisma);
      forgetPackageReuse(current.id);
      const row = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: { where: { id: current.id }, select: packageDetailSelect },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      return { ...serializePackage(row), ...serializeRecentCheckouts(row), notes: row.notes };
    }),

  /**
   * Re-key a snapshot package (pasted credentials). Answers at once: the
   * pasted key lives only in the background task's memory (never in a job or
   * any row) while it clones or refreshes, and the package shows the
   * progress and outcome (`repository.snapshotSync`). A second call while one
   * runs joins it. With `save`, the key is stored and the package becomes an
   * ordinary SSH package: its repository is then fetched by a normal,
   * durable job.
   */
  updateSnapshot: protectedProcedure
    .input(z.object({ id: entityId, key: pastedSshKeySchema }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const current = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: {
          where: { id: input.id, isSnapshot: true },
          select: { id: true, gitUrl: true, repositoryId: true },
        },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      await consumePackageWriteBudget(`user:${ownerId}`);
      await consumeKeyWriteBudget(`user:${ownerId}`);
      return withDomainErrors(async () => {
        let createdRepositoryId: string | undefined;
        try {
          await validateRemoteUrl(current.gitUrl);
          const key = input.key;
          const normalized = await normalizeImportedPrivateKey(
            key.privateKey,
            key.passphrase || undefined,
          );
          // Serialized per package, on the repository it has NOW: a concurrent
          // re-key or conversion may have attached or converted one meanwhile.
          // A wait past PACKAGE_GATE_WAIT_MS answers REPOSITORY_BUSY before
          // anything is written, so the request can simply be retried.
          return await withSnapshotPackageGate(current.id, async () => {
            const fresh = await prisma.package.findFirst({
              where: { id: current.id, ownerId, isSnapshot: true },
              select: { repositoryId: true },
            });
            if (!fresh) throw snapshotRefMissing();
            // Stored only once this request holds the gate and the package is
            // still a snapshot.
            const saved = key.save
              ? await importSshKey({
                  ownerId,
                  name: key.name!,
                  privateKey: key.privateKey,
                  passphrase: key.passphrase,
                })
              : null;
            if (saved) {
              const repositoryIdNow = fresh.repositoryId;
              // No pasted-key task may go on (or start) once the key is saved.
              await withSnapshotTasksClosed(repositoryIdNow, () =>
                prisma.$transaction(async (tx) => {
                  const { count } = await tx.package.updateMany({
                    where: {
                      id: current.id,
                      ownerId,
                      isSnapshot: true,
                      repositoryId: repositoryIdNow,
                    },
                    data: { isSnapshot: false, sshKeyId: saved.id },
                  });
                  if (count === 0) throw snapshotRefMissing();
                  if (repositoryIdNow)
                    await tx.repository.updateMany({
                      where: { id: repositoryIdNow, ownerId },
                      data: {
                        isSnapshot: false,
                        sshKeyId: saved.id,
                        snapshotSyncStatus: "NONE",
                        snapshotSyncError: null,
                      },
                    });
                }),
              );
              if (repositoryIdNow) {
                const slot = Math.floor(Date.now() / 60_000);
                await enqueueJob(
                  fetchRepositoryJob,
                  { repositoryId: repositoryIdNow, mode: "default" },
                  { dedupeKey: `repository.fetch:${repositoryIdNow}:rekey:${slot}` },
                );
              }
              forgetPackageReuse(current.id);
              return { ok: true as const, syncing: Boolean(repositoryIdNow) };
            }
            let repositoryId = fresh.repositoryId;
            let kind: SnapshotSyncKind = "refresh";
            if (!repositoryId) {
              const repo = await createSnapshotRepositoryRow({ gitUrl: current.gitUrl, ownerId });
              createdRepositoryId = repo.id;
              const { count } = await prisma.package.updateMany({
                where: { id: current.id, ownerId, isSnapshot: true, repositoryId: null },
                data: { repositoryId: repo.id },
              });
              if (count === 0) throw snapshotRefMissing();
              createdRepositoryId = undefined;
              repositoryId = repo.id;
              kind = "clone";
            }
            await startSnapshotSync({
              repositoryId,
              ownerId,
              privateKey: normalized.privateKey,
              kind,
              onSynced: () => forgetPackageReuse(current.id),
            });
            return { ok: true as const, syncing: true };
          });
        } catch (error) {
          if (createdRepositoryId) await deleteRepository(createdRepositoryId).catch(() => {});
          throw safeSnapshotError(error);
        }
      });
    }),

  /**
   * Delete a package. A snapshot's own clone goes with it: its background
   * clone or refresh is cancelled first, and the package's snapshot gate and
   * the repository lock are each waited for a bounded time (then CONFLICT /
   * REPOSITORY_BUSY).
   */
  delete: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      // Serialized with re-keys: a concurrent one cannot attach (and start
      // cloning) a replacement snapshot this delete would then miss. Both
      // waits are bounded (the gate's PACKAGE_GATE_WAIT_MS, then the
      // repository lock's REQUEST_LOCK_WAIT_MS) and answer CONFLICT /
      // REPOSITORY_BUSY, so the delete can be retried.
      await withDomainErrors(() =>
        withSnapshotPackageGate(input.id, async () => {
          const snapshot = await prisma.package.findFirst({
            where: { id: input.id, ownerId, isSnapshot: true },
            select: { repositoryId: true },
          });
          if (snapshot?.repositoryId) {
            const repositoryId = snapshot.repositoryId;
            // Its clone or refresh is killed; the bounded lock wait covers the
            // unwinding.
            cancelSnapshotSync(repositoryId);
            await deleteRepository(repositoryId, { lockWaitMs: REQUEST_LOCK_WAIT_MS });
          }
          // Conversations keep `packageIdentifier` (their FK is SetNull); a live
          // run notices on its next lease renewal.
          const { count } = await prisma.package.deleteMany({ where: { id: input.id, ownerId } });
          if (count === 0)
            throw reasonError("NOT_FOUND", "PACKAGE_NOT_FOUND", "Package not found.");
        }),
      );
      forgetPackageReuse(input.id);
      return { ok: true as const };
    }),

  lookupRegistry: protectedProcedure
    .input(
      z.object({
        ecosystem: ecosystemSchema.exclude(["git"]),
        name: shortText,
      }),
    )
    .handler(async ({ input, context }) => {
      const name = normalizeNameOrThrow(input.ecosystem, input.name);
      await consumeRegistryLookupBudget(`user:${context.session.user.id}`);
      const result = await lookupRegistry({ ecosystem: input.ecosystem, name });
      if (result.status === "found") return { status: "found" as const, ...result.suggestion };
      return { status: result.status };
    }),
};
