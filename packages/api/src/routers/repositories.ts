import prisma, { type Prisma } from "@cockpit-context/db";
import { enqueueJob, MINUTE, slotStart } from "@cockpit-context/jobs";
import { deleteCheckout } from "@cockpit-context/repos";
import { fetchRepositoryJob } from "@cockpit-context/repos/jobs";
import { getRunEngine, loadRunConfig } from "@cockpit-context/runs";
import { invalidateAnswersForRepository } from "@cockpit-context/runs/answer-reuse";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError, withDomainErrors } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import { lower } from "../lib/packages";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { cockpitContextRateBudget } from "../lib/rate-budgets";
import { entityId } from "../lib/schemas";

/**
 * Checkouts behind the caller's packages (docs/product.md).
 *
 * Ownership: a checkout is reachable only through one of the caller's own
 * packages whose repository holds it (`Package.repositoryId`). A public
 * repository row is shared, so its checkouts are a cache that any user whose
 * package uses it may see and delete (the ownership rules in
 * docs/access-matrix.md); a private row is only ever linked to its
 * owner's packages. Admins use `adminStorage.*`, not these procedures.
 */

/**
 * One point per manual refresh: an outbound `git fetch` against the
 * package's remote. The default 20 per 10 minutes
 * (`COCKPIT_CONTEXT_REPOSITORY_REFRESHES_PER_10_MINUTES`) is a refresh every 30 s; the job's
 * dedupe slot collapses double clicks inside a minute anyway.
 */
const consumeRefreshBudget = createProcedureBudget({
  keyPrefix: "rl:repositories-refresh",
  budget: () => cockpitContextRateBudget("repositoryRefresh"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many refreshes. Try again in ${seconds}s.`,
  unavailableMessage: "Refreshing is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[repositories] refresh budget unavailable, failing closed:",
});

/**
 * One point per summary regeneration: one SUMMARY run of the explore agent
 * (model spend). The default 10 per hour
 * (`COCKPIT_CONTEXT_SUMMARY_REGENERATIONS_PER_HOUR`) leaves room for a few retries after a failure.
 */
const consumeSummaryBudget = createProcedureBudget({
  keyPrefix: "rl:repositories-regenerate-summary",
  budget: () => cockpitContextRateBudget("summaryRegenerate"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many summary requests. Try again in ${seconds}s.`,
  unavailableMessage: "Summaries are temporarily unavailable. Try again in a moment.",
  unavailableLog: "[repositories] summary budget unavailable, failing closed:",
});

const MAX_SUMMARY_LENGTH = 20_000;

const checkoutViewSelect = {
  id: true,
  createdAt: true,
  sha: true,
  resolvedFrom: true,
  status: true,
  diskBytes: true,
  lastUsedAt: true,
  summary: true,
  summaryStatus: true,
  summaryModel: true,
  summaryGeneratedAt: true,
} satisfies Prisma.CheckoutSelect;

/**
 * The viewer's own override only. Overrides are private: this projection is
 * the only way one reaches a client, and it is always keyed on the session.
 */
function overrideSelectFor(viewerId: string) {
  return {
    SummaryOverrides: {
      where: { userId: viewerId },
      select: { body: true, updatedAt: true },
      take: 1,
    },
  } satisfies Prisma.CheckoutSelect;
}

type CheckoutViewRow = Prisma.CheckoutGetPayload<{
  select: typeof checkoutViewSelect & ReturnType<typeof overrideSelectFor>;
}>;

function serializeCheckout(row: CheckoutViewRow, leased: boolean) {
  const override = row.SummaryOverrides[0];
  return {
    id: row.id,
    createdAt: row.createdAt,
    sha: row.sha,
    resolvedFrom: row.resolvedFrom,
    status: lower(row.status),
    diskBytes: Number(row.diskBytes),
    lastUsedAt: row.lastUsedAt,
    /**
     * The shared model-written overview (render as markdown, never as HTML).
     * Only the model writes it; every user who can reach the checkout sees it.
     */
    summary: row.summary,
    summaryStatus: lower(row.summaryStatus),
    summaryModel: row.summaryModel,
    summaryGeneratedAt: row.summaryGeneratedAt,
    /** The viewer's own edited version, which their runs use instead. */
    summaryOverride: override ? { body: override.body, updatedAt: override.updatedAt } : null,
    leased,
  };
}

/** One checkout as the viewer sees it after an override write. */
async function viewCheckout(checkoutId: string, viewerId: string) {
  const now = new Date();
  const row = await prisma.checkout.findUnique({
    where: { id: checkoutId },
    select: {
      ...checkoutViewSelect,
      ...overrideSelectFor(viewerId),
      Leases: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
    },
  });
  if (!row) throw reasonError("NOT_FOUND", "CHECKOUT_NOT_FOUND", "Checkout not found.");
  return serializeCheckout(row, row.Leases.length > 0);
}

function prismaCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function ownerOf(context: { session: { user: { id: string } } }) {
  return { field: "ownerId", id: context.session.user.id };
}

/**
 * The caller's package that reaches `checkoutId` (through its repository),
 * or NOT_FOUND. `packageId` narrows it to that package.
 */
async function ownedPackageForCheckout(
  context: { session: { user: { id: string } } },
  checkoutId: string,
  packageId?: string,
) {
  return findOwnedOrThrow({
    find: (args) => prisma.package.findFirst(args),
    args: {
      where: {
        ...(packageId ? { id: packageId } : {}),
        Repository: { Checkouts: { some: { id: checkoutId } } },
      },
      select: { id: true, repositoryId: true, isSnapshot: true },
    },
    owner: ownerOf(context),
    notFound: "Checkout not found.",
  });
}

export const repositoriesRouter = {
  listCheckouts: protectedProcedure
    .input(cursorPageInput.extend({ packageId: entityId }))
    .handler(async ({ input, context }) => {
      const pkg = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: {
          where: { id: input.packageId },
          select: { id: true, repositoryId: true, isSnapshot: true },
        },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      if (!pkg.repositoryId) return { items: [], nextCursor: null };
      const now = new Date();
      const rows = await prisma.checkout.findMany({
        where: withCursor({ repositoryId: pkg.repositoryId }, "createdAt", input.cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(input.limit),
        select: {
          ...checkoutViewSelect,
          ...overrideSelectFor(context.session.user.id),
          Leases: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
        },
      });
      const page = cursorPage(rows, input.limit, "createdAt");
      return {
        items: page.items.map((row) => serializeCheckout(row, row.Leases.length > 0)),
        nextCursor: page.nextCursor,
      };
    }),

  /** Queue a `git fetch` of the package's repository (default branches). */
  refresh: protectedProcedure
    .input(z.object({ packageId: entityId }))
    .handler(async ({ input, context }) => {
      const pkg = await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: {
          where: { id: input.packageId },
          select: { id: true, repositoryId: true, isSnapshot: true },
        },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      if (pkg.isSnapshot)
        throw reasonError(
          "BAD_REQUEST",
          "PACKAGE_SNAPSHOT_REF_MISSING",
          "Update this snapshot with your SSH key.",
        );
      // Never cloned (or pruned): the next question clones it fresh, which
      // is already the latest default branch.
      if (!pkg.repositoryId) return { queued: false as const, reason: "not_cloned" as const };
      await consumeRefreshBudget(`user:${context.session.user.id}`);
      const slot = slotStart(Date.now(), MINUTE);
      await enqueueJob(
        fetchRepositoryJob,
        { repositoryId: pkg.repositoryId, mode: "default" },
        { dedupeKey: `repository.fetch:${pkg.repositoryId}:manual:${slot}` },
      );
      return { queued: true as const, reason: null };
    }),

  /** Remove a checkout's worktree. Refused while a run reads it (CONFLICT / CHECKOUT_LEASED). */
  deleteCheckout: protectedProcedure
    .input(z.object({ checkoutId: entityId }))
    .handler(async ({ input, context }) => {
      await ownedPackageForCheckout(context, input.checkoutId);
      const { freedBytes } = await withDomainErrors(() => deleteCheckout(input.checkoutId));
      return { freedBytes: Number(freedBytes) };
    }),

  /**
   * Save the caller's own edited overview of a checkout (an override).
   * Private to the caller: only their views and their runs read it, it never
   * changes the shared generated summary, and nobody else can see, replace
   * or delete it. The caller must reach the checkout through one of their
   * own packages.
   */
  updateSummary: protectedProcedure
    .input(
      z.object({
        checkoutId: entityId,
        summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const pkg = await ownedPackageForCheckout(context, input.checkoutId);
      try {
        await prisma.checkoutSummaryOverride.upsert({
          where: { checkoutId_userId: { checkoutId: input.checkoutId, userId } },
          create: { checkoutId: input.checkoutId, userId, body: input.summary },
          update: { body: input.summary },
          select: { id: true },
        });
      } catch (error) {
        // The checkout was pruned between the ownership check and the write.
        if (prismaCode(error) === "P2003") {
          throw reasonError("NOT_FOUND", "CHECKOUT_NOT_FOUND", "Checkout not found.");
        }
        throw error;
      }
      // The caller's reused MCP answers read the old overview (docs/mcp.md § Answer reuse).
      if (pkg.repositoryId) invalidateAnswersForRepository(pkg.repositoryId, userId);
      return viewCheckout(input.checkoutId, userId);
    }),

  /** Delete the caller's own override, so their runs use the generated summary again. */
  revertSummary: protectedProcedure
    .input(z.object({ checkoutId: entityId }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const pkg = await ownedPackageForCheckout(context, input.checkoutId);
      await prisma.checkoutSummaryOverride.deleteMany({
        where: { checkoutId: input.checkoutId, userId },
      });
      if (pkg.repositoryId) invalidateAnswersForRepository(pkg.repositoryId, userId);
      return viewCheckout(input.checkoutId, userId);
    }),

  /**
   * Queue a fresh model-written overview (spends the caller's model budget).
   * Replaces only the shared generated summary; every user's override,
   * including the caller's, is left as it is.
   */
  regenerateSummary: protectedProcedure
    .input(z.object({ checkoutId: entityId, packageId: entityId.optional() }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const pkg = await ownedPackageForCheckout(context, input.checkoutId, input.packageId);
      const config = loadRunConfig();
      if (!config.apiKey || !config.model) {
        throw reasonError(
          "SERVICE_UNAVAILABLE",
          "MODEL_NOT_CONFIGURED",
          "No model is configured on this server.",
        );
      }
      await consumeSummaryBudget(`user:${ownerId}`);
      const requested = await withDomainErrors(() =>
        getRunEngine().requestCheckoutSummary({
          checkoutId: input.checkoutId,
          ownerId,
          packageId: pkg.id,
          force: true,
        }),
      );
      return { requested };
    }),
};
