import prisma, { type Prisma } from "@cockpit-context/db";
import { fromStoredEcosystem } from "@cockpit-context/repos";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import {
  consumePackageWriteBudget,
  discardPreparedSnapshot,
  gitUrlSchema,
  insertPackage,
  lower,
  preparePackageSource,
  refSchema,
  serializePackage,
  subdirectorySchema,
  tagPatternSchema,
} from "../lib/packages";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId, longText, shortText } from "../lib/schemas";
import { pastedSshKeySchema } from "../lib/ssh-key-input";

/**
 * Agent proposals (docs/product.md). Created by the
 * MCP tool `propose_dependency`; decided here, by the owner only. Approving
 * creates the package; rejecting records an optional reason the agent can
 * read back with `get_proposal`.
 */

const proposalSelect = {
  id: true,
  createdAt: true,
  status: true,
  ecosystem: true,
  name: true,
  identifier: true,
  displayName: true,
  gitUrl: true,
  subdirectory: true,
  version: true,
  reason: true,
  rejectionReason: true,
  decidedAt: true,
  packageId: true,
  connectionLabel: true,
} satisfies Prisma.PackageProposalSelect;

type ProposalRow = Prisma.PackageProposalGetPayload<{ select: typeof proposalSelect }>;

function serializeProposal(row: ProposalRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    status: lower(row.status),
    ecosystem: fromStoredEcosystem(row.ecosystem),
    name: row.name,
    identifier: row.identifier,
    displayName: row.displayName,
    gitUrl: row.gitUrl,
    subdirectory: row.subdirectory,
    version: row.version,
    /** Agent-written: render as plain text. */
    reason: row.reason,
    rejectionReason: row.rejectionReason,
    decidedAt: row.decidedAt,
    packageId: row.packageId,
    connectionLabel: row.connectionLabel,
  };
}

function ownerOf(context: { session: { user: { id: string } } }) {
  return { field: "ownerId", id: context.session.user.id };
}

function notPending() {
  return reasonError("CONFLICT", "PROPOSAL_DECIDED", "That proposal was already decided.");
}

export const proposalsRouter = {
  list: protectedProcedure
    .input(
      cursorPageInput.extend({
        /** `pending` first in the UI, then `decided` (approved and rejected) as history. */
        status: z.enum(["pending", "decided"]).default("pending"),
      }),
    )
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const where: Prisma.PackageProposalWhereInput =
        input.status === "pending"
          ? { ownerId, status: "PENDING" }
          : { ownerId, status: { in: ["APPROVED", "REJECTED"] } };
      const [rows, pendingCount] = await Promise.all([
        prisma.packageProposal.findMany({
          where: withCursor(where, "createdAt", input.cursor, "desc"),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageTake(input.limit),
          select: proposalSelect,
        }),
        prisma.packageProposal.count({ where: { ownerId, status: "PENDING" } }),
      ]);
      const page = cursorPage(rows, input.limit, "createdAt");
      return {
        items: page.items.map(serializeProposal),
        nextCursor: page.nextCursor,
        pendingCount,
      };
    }),

  /**
   * Approve a pending proposal, creating the package from the proposal's
   * suggestions with the owner's edits applied. If the owner already has a
   * package with that identifier, the proposal is approved against it and
   * nothing is created (`created: false`).
   */
  approve: protectedProcedure
    .input(
      z.object({
        id: entityId,
        displayName: shortText.optional(),
        gitUrl: gitUrlSchema.optional(),
        sshKeyId: entityId.nullish(),
        oneTimeKey: pastedSshKeySchema.optional(),
        subdirectory: subdirectorySchema.nullish(),
        tagPattern: tagPatternSchema.nullish(),
        defaultRef: refSchema.nullish(),
        notes: longText.nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const proposal = await findOwnedOrThrow({
        find: (args) => prisma.packageProposal.findFirst(args),
        args: { where: { id: input.id }, select: proposalSelect },
        owner: ownerOf(context),
        notFound: "Proposal not found.",
      });
      if (proposal.status !== "PENDING") throw notPending();

      const existing = await prisma.package.findFirst({
        where: { ownerId, identifier: proposal.identifier },
        select: { id: true },
      });
      if (existing) {
        const { count } = await prisma.packageProposal.updateMany({
          where: { id: proposal.id, ownerId, status: "PENDING" },
          data: { status: "APPROVED", decidedAt: new Date(), packageId: existing.id },
        });
        if (count === 0) throw notPending();
        return { created: false, packageId: existing.id, package: null };
      }

      const gitUrl = input.gitUrl ?? proposal.gitUrl;
      if (!gitUrl) {
        throw reasonError("BAD_REQUEST", "GIT_URL_REQUIRED", "Add a git URL before approving.");
      }
      // Network I/O (DNS) stays outside the transaction, and is budgeted
      // like packages.create (the same rl:packages-write bucket).
      await consumePackageWriteBudget(`user:${ownerId}`);
      const source = await preparePackageSource(ownerId, {
        gitUrl,
        sshKeyId: input.sshKeyId ?? null,
        oneTimeKey: input.oneTimeKey,
      });
      const pkg = await prisma
        .$transaction(async (tx) => {
          // Claim the proposal first: a concurrent approve or reject loses here
          // and creates nothing.
          const { count } = await tx.packageProposal.updateMany({
            where: { id: proposal.id, ownerId, status: "PENDING" },
            data: { status: "APPROVED", decidedAt: new Date() },
          });
          if (count === 0) throw notPending();
          const created = await insertPackage(tx, ownerId, {
            ecosystem: fromStoredEcosystem(proposal.ecosystem),
            name: proposal.name,
            displayName: input.displayName ?? proposal.displayName ?? undefined,
            ...source,
            subdirectory:
              input.subdirectory === undefined ? proposal.subdirectory : input.subdirectory,
            tagPattern: input.tagPattern,
            defaultRef: input.defaultRef,
            notes: input.notes,
          });
          await tx.packageProposal.updateMany({
            where: { id: proposal.id, ownerId },
            data: { packageId: created.id },
          });
          return created;
        })
        .catch(async (error: unknown) => {
          await discardPreparedSnapshot(source);
          throw error;
        });
      return { created: true, packageId: pkg.id, package: serializePackage(pkg) };
    }),

  reject: protectedProcedure
    .input(z.object({ id: entityId, reason: longText.optional() }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const proposal = await findOwnedOrThrow({
        find: (args) => prisma.packageProposal.findFirst(args),
        args: { where: { id: input.id }, select: { id: true, status: true } },
        owner: ownerOf(context),
        notFound: "Proposal not found.",
      });
      if (proposal.status !== "PENDING") throw notPending();
      const { count } = await prisma.packageProposal.updateMany({
        where: { id: proposal.id, ownerId, status: "PENDING" },
        data: {
          status: "REJECTED",
          decidedAt: new Date(),
          rejectionReason: input.reason ?? null,
        },
      });
      if (count === 0) throw notPending();
      return { ok: true as const };
    }),
};
