import { mkdir, stat } from "node:fs/promises";

import prisma, { type Prisma } from "@cockpit-context/db";

import { lastErrorText, RepoError } from "./errors";
import { runGit } from "./git-exec";
import { repositoryLockKey, withLock } from "./locks";
import { withGitNetwork } from "./network";
import {
  assertFullSha,
  checkoutDir,
  removeInsideDataDir,
  repositoryCheckoutsDir,
  repositoryDir,
} from "./paths";
import { notifyCheckoutRemoval } from "./removal-hooks";
import {
  CLONE_TIMEOUT_MS,
  cloneRepository,
  connectSpecFor,
  fetchCommitLocked,
  type GitLayerDeps,
  loadRepository,
} from "./repositories";
import { measureDirectory } from "./storage";

/**
 * Checkouts: one detached worktree of a repository at one commit, unique per
 * (repository, sha) and the unit of pruning (docs/product.md). Like repositories.ts, these take ids; the caller enforces
 * ownership first.
 */

export const checkoutSelect = {
  id: true,
  createdAt: true,
  repositoryId: true,
  sha: true,
  resolvedFrom: true,
  status: true,
  lastError: true,
  diskBytes: true,
  lastUsedAt: true,
  summaryStatus: true,
} satisfies Prisma.CheckoutSelect;

export type CheckoutRecord = Prisma.CheckoutGetPayload<{ select: typeof checkoutSelect }>;

export interface ReadyCheckout extends CheckoutRecord {
  /** Absolute path of the worktree; what the explore tools are confined to. */
  path: string;
}

function withPath(row: CheckoutRecord): ReadyCheckout {
  return { ...row, path: checkoutDir(row.repositoryId, row.sha) };
}

async function worktreeExists(path: string): Promise<boolean> {
  try {
    return (await stat(`${path}/.git`)).isFile();
  } catch {
    return false;
  }
}

/** Remove a worktree directory and git's bookkeeping for it; tolerant of either being gone. */
export async function removeWorktree(repositoryId: string, path: string): Promise<void> {
  const gitDir = repositoryDir(repositoryId);
  const hasRepo = await stat(`${gitDir}/HEAD`).then(
    () => true,
    () => false,
  );
  if (hasRepo) {
    await runGit(["worktree", "remove", "--force", "--force", path], { gitDir }).catch(() => {});
  }
  await removeInsideDataDir(path);
  if (hasRepo) await runGit(["worktree", "prune"], { gitDir }).catch(() => {});
}

/**
 * Find or create the checkout row for (repository, sha) and make sure its
 * worktree exists. Returns the READY checkout with its path.
 */
export async function ensureCheckout(
  input: { repositoryId: string; sha: string; resolvedFrom?: string | null; signal?: AbortSignal },
  deps: GitLayerDeps = {},
): Promise<ReadyCheckout> {
  const sha = assertFullSha(input.sha);
  const row = await prisma.checkout.upsert({
    where: { repositoryId_sha: { repositoryId: input.repositoryId, sha } },
    create: { repositoryId: input.repositoryId, sha, resolvedFrom: input.resolvedFrom ?? null },
    update: input.resolvedFrom ? { resolvedFrom: input.resolvedFrom } : {},
    select: { id: true },
  });
  return materializeCheckout(row.id, { signal: input.signal }, deps);
}

/**
 * Create the worktree for an existing checkout row (`ensureCheckout` and the
 * run engine). Re-clones the repository first if it was pruned. Idempotent:
 * a READY checkout whose worktree exists is only touched.
 */
export async function materializeCheckout(
  checkoutId: string,
  options: { signal?: AbortSignal } = {},
  deps: GitLayerDeps = {},
): Promise<ReadyCheckout> {
  const initial = await prisma.checkout.findUnique({
    where: { id: checkoutId },
    select: checkoutSelect,
  });
  if (!initial) throw new RepoError("CHECKOUT_NOT_FOUND", "Checkout not found.");
  const at = () => deps.now?.() ?? new Date();
  const path = checkoutDir(initial.repositoryId, initial.sha);
  if (initial.status === "READY" && (await worktreeExists(path))) {
    return withPath(
      await prisma.checkout.update({
        where: { id: checkoutId },
        data: { lastUsedAt: at() },
        select: checkoutSelect,
      }),
    );
  }

  try {
    await cloneRepository(initial.repositoryId, options, deps);
  } catch (error) {
    // The clone failed (its row says why): this checkout cannot be made
    // either, so it must not stay PENDING for the UI to poll forever. The
    // worktree path is untouched, so diskBytes stays what it was. This runs
    // outside the repository lock: a concurrent materialization may already
    // have made it READY, which a failed clone here must not overwrite.
    await prisma.checkout
      .updateMany({
        where: { id: checkoutId, status: { not: "READY" } },
        data: { status: "FAILED", lastError: lastErrorText(error) },
      })
      .catch(() => {});
    throw error;
  }

  return withLock(
    repositoryLockKey(initial.repositoryId),
    async () => {
      const row = await prisma.checkout.findUnique({
        where: { id: checkoutId },
        select: checkoutSelect,
      });
      if (!row) throw new RepoError("CHECKOUT_NOT_FOUND", "Checkout not found.");
      if (row.status === "READY" && (await worktreeExists(path))) return withPath(row);
      const repo = await loadRepository(row.repositoryId);
      const gitDir = repositoryDir(repo.id);
      try {
        await removeWorktree(repo.id, path);
        await mkdir(repositoryCheckoutsDir(repo.id), { recursive: true, mode: 0o700 });
        const hasCommit = () =>
          runGit(["cat-file", "-e", `${row.sha}^{commit}`], { gitDir }).then(
            () => true,
            () => false,
          );
        // Local git calls cannot lazily fetch it; a commit only on the server
        // is fetched by id through the pinned network path.
        const present =
          (await hasCommit()) ||
          ((await fetchCommitLocked(repo, row.sha, options, deps)) && (await hasCommit()));
        if (!present) {
          throw new RepoError(
            "REF_NOT_FOUND",
            `Commit ${row.sha} is not in the repository (was it force-pushed away?).`,
          );
        }
        // Blobless clone: the worktree add lazily fetches this commit's blobs,
        // so it needs the same pinned network settings as a fetch.
        const addWorktree = (network?: import("./git-exec").GitNetwork) =>
          runGit(["worktree", "add", "--detach", "--quiet", path, row.sha], {
            gitDir,
            network,
            timeoutMs: CLONE_TIMEOUT_MS,
            signal: options.signal,
          });
        if (repo.isSnapshot) await addWorktree();
        else
          await withGitNetwork(
            { ...connectSpecFor(repo), signal: options.signal },
            addWorktree,
            deps,
          );
        const sizeOf = deps.measure ?? measureDirectory;
        const [checkoutSize, repoSize] = [
          await sizeOf(path, { signal: options.signal }),
          await sizeOf(gitDir, { signal: options.signal }),
        ];
        const when = at();
        await prisma.repository.update({
          where: { id: repo.id },
          data: { diskBytes: repoSize.bytes, lastUsedAt: when },
          select: { id: true },
        });
        return withPath(
          await prisma.checkout.update({
            where: { id: checkoutId },
            data: {
              status: "READY",
              lastError: null,
              diskBytes: checkoutSize.bytes,
              lastUsedAt: when,
            },
            select: checkoutSelect,
          }),
        );
      } catch (error) {
        await removeWorktree(repo.id, path).catch(() => {});
        await prisma.checkout.update({
          where: { id: checkoutId },
          data: { status: "FAILED", lastError: lastErrorText(error), diskBytes: 0n },
          select: { id: true },
        });
        throw error;
      }
    },
    options.signal,
  );
}

/**
 * Remove a checkout's worktree (`git worktree remove --force`, then `git
 * worktree prune`) and its row. Conversations keep their `commitSha` and
 * re-create it on follow-up. Refused while a run holds an unexpired lease
 * unless `force`.
 */
export async function deleteCheckout(
  checkoutId: string,
  options: { force?: boolean } = {},
  deps: GitLayerDeps = {},
): Promise<{ freedBytes: bigint }> {
  const row = await prisma.checkout.findUnique({
    where: { id: checkoutId },
    select: checkoutSelect,
  });
  if (!row) throw new RepoError("CHECKOUT_NOT_FOUND", "Checkout not found.");
  return withLock(repositoryLockKey(row.repositoryId), async () => {
    if (!options.force) {
      const leased = await prisma.checkoutLease.count({
        where: { checkoutId, expiresAt: { gt: deps.now?.() ?? new Date() } },
      });
      if (leased > 0) {
        throw new RepoError("CHECKOUT_LEASED", "A running investigation is using this checkout.");
      }
    }
    await notifyCheckoutRemoval([checkoutId]);
    await removeWorktree(row.repositoryId, checkoutDir(row.repositoryId, row.sha));
    await prisma.checkout.delete({ where: { id: checkoutId }, select: { id: true } });
    return { freedBytes: row.diskBytes };
  });
}
