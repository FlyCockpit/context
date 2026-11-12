import prisma, { type Prisma } from "@cockpit-context/db";
import {
  createSnapshotRepository,
  deleteRepository,
  importSshKey,
  lookupRegistry,
  normalizeImportedPrivateKey,
  safeSnapshotError,
  snapshotRefMissing,
  toStoredEcosystem,
  updateSnapshotRepository,
  validateRemoteUrl,
} from "@cockpit-context/repos";
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
      const write = async (db: Prisma.TransactionClient | typeof prisma) => {
        const { count } = await db.package.updateMany({ where: { id: current.id, ownerId }, data });
        if (count === 0) throw reasonError("NOT_FOUND", "PACKAGE_NOT_FOUND", "Package not found.");
        if (current.isSnapshot && current.repositoryId && data.isSnapshot === false) {
          await db.repository.updateMany({
            where: { id: current.repositoryId, ownerId, isSnapshot: true },
            data: {
              isSnapshot: false,
              sshKeyId: typeof data.sshKeyId === "string" ? data.sshKeyId : null,
            },
          });
        }
      };
      if (current.isSnapshot && data.isSnapshot === false) await prisma.$transaction(write);
      else await write(prisma);
      forgetPackageReuse(current.id);
      const row = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: { where: { id: current.id }, select: packageDetailSelect },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      return { ...serializePackage(row), ...serializeRecentCheckouts(row), notes: row.notes };
    }),

  /** Pasted credentials stay in this request; no job or secret-bearing row is created. */
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
      const result = await withDomainErrors(async () => {
        let unlinkedRepositoryId: string | undefined;
        try {
          await validateRemoteUrl(current.gitUrl);
          const key = input.key;
          const normalized = await normalizeImportedPrivateKey(
            key.privateKey,
            key.passphrase || undefined,
          );
          const saved = key.save
            ? await importSshKey({
                ownerId,
                name: key.name!,
                privateKey: key.privateKey,
                passphrase: key.passphrase,
              })
            : null;
          const repo = current.repositoryId
            ? await updateSnapshotRepository(current.repositoryId, ownerId, normalized.privateKey)
            : await createSnapshotRepository(
                { gitUrl: current.gitUrl, ownerId },
                normalized.privateKey,
              );
          if (!current.repositoryId) unlinkedRepositoryId = repo.id;
          await prisma.$transaction(async (tx) => {
            const { count } = await tx.package.updateMany({
              where: {
                id: current.id,
                ownerId,
                isSnapshot: true,
                repositoryId: current.repositoryId,
              },
              data: {
                repositoryId: repo.id,
                ...(saved ? { isSnapshot: false, sshKeyId: saved.id } : {}),
              },
            });
            if (count === 0) throw snapshotRefMissing();
            if (saved)
              await tx.repository.updateMany({
                where: { id: repo.id, ownerId },
                data: { isSnapshot: false, sshKeyId: saved.id },
              });
          });
          unlinkedRepositoryId = undefined;
          forgetPackageReuse(current.id);
          return { ok: true as const };
        } catch (error) {
          if (unlinkedRepositoryId) await deleteRepository(unlinkedRepositoryId).catch(() => {});
          throw safeSnapshotError(error);
        }
      });
      return result;
    }),

  delete: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const snapshot = await prisma.package.findFirst({
        where: { id: input.id, ownerId, isSnapshot: true },
        select: { repositoryId: true },
      });
      if (snapshot?.repositoryId)
        await withDomainErrors(() => deleteRepository(snapshot.repositoryId!));
      // Conversations keep `packageIdentifier` (their FK is SetNull); a live
      // run notices on its next lease renewal.
      const { count } = await prisma.package.deleteMany({ where: { id: input.id, ownerId } });
      if (count === 0) throw reasonError("NOT_FOUND", "PACKAGE_NOT_FOUND", "Package not found.");
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
