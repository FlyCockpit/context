import { randomBytes, randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";

import prisma, { type Prisma } from "@cockpit-context/db";

import { fetchIntervalMs } from "./config";
import { isRepoError, lastErrorText, RepoError } from "./errors";
import { GitCommandError, gitFailure, runGit } from "./git-exec";
import { repositoryLockKey, withLock } from "./locks";
import { type ConnectSpec, type NetworkDeps, withGitNetwork } from "./network";
import { fetchNpmGitHead } from "./npm-registry";
import {
  assertFullSha,
  checkoutDir,
  ensureDataDirs,
  removeInsideDataDir,
  repositoryCheckoutsDir,
  repositoryDir,
  reposRoot,
} from "./paths";
import { parseRemoteUrl } from "./remote-url";
import { notifyCheckoutRemoval } from "./removal-hooks";
import { notifyRepositoryChange } from "./repository-change-hooks";
import {
  bareRepoRefs,
  isSafeRefName,
  type Resolution,
  type ResolvablePackage,
  type ResolveInput,
  readDefaultBranch,
  resolveInRepo,
} from "./resolve";
import { type MeasureFn, measureDirectory } from "./storage";

/**
 * Repositories: bare, blobless clones keyed by normalized remote + owner
 * scope (docs/product.md). Public HTTPS remotes are
 * one shared clone (`ownerId` null); SSH remotes are always owned by one user
 * and never shared.
 *
 * These functions take ids, not sessions: ownership (which packages a caller
 * may resolve, which checkouts they may delete) is enforced by the routers
 * and the run engine before they call in.
 */

export const repositorySelect = {
  id: true,
  createdAt: true,
  remoteUrl: true,
  remoteKey: true,
  visibility: true,
  ownerId: true,
  sshKeyId: true,
  isSnapshot: true,
  status: true,
  lastError: true,
  defaultBranch: true,
  diskBytes: true,
  lastFetchedAt: true,
  lastUsedAt: true,
} satisfies Prisma.RepositorySelect;

export type RepositoryRecord = Prisma.RepositoryGetPayload<{ select: typeof repositorySelect }>;

/** The package fields `resolveTarget` reads; load packages with this projection. */
export const packageResolveSelect = {
  id: true,
  ownerId: true,
  ecosystem: true,
  name: true,
  gitUrl: true,
  sshKeyId: true,
  isSnapshot: true,
  repositoryId: true,
  tagPattern: true,
  defaultRef: true,
} satisfies Prisma.PackageSelect;

export type ResolvePackageRecord = Prisma.PackageGetPayload<{
  select: typeof packageResolveSelect;
}>;

export interface GitLayerDeps extends NetworkDeps {
  measure?: MeasureFn;
  npmGitHead?: (name: string, version: string) => Promise<string | null>;
  now?: () => Date;
}

export const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 10 * 60_000;

function now(deps: GitLayerDeps): Date {
  return deps.now?.() ?? new Date();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

export function connectSpecFor(
  repo: Pick<RepositoryRecord, "remoteUrl" | "ownerId" | "sshKeyId">,
): ConnectSpec {
  return { remote: parseRemoteUrl(repo.remoteUrl), ownerId: repo.ownerId, sshKeyId: repo.sshKeyId };
}

export async function loadRepository(repositoryId: string): Promise<RepositoryRecord> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: repositorySelect,
  });
  if (!repo) throw new RepoError("REPOSITORY_NOT_FOUND", "Repository not found.");
  return repo;
}

/** True when `dir` holds a bare repository we created (has HEAD and objects/). */
async function isBareRepository(dir: string): Promise<boolean> {
  try {
    const [head, objects] = await Promise.all([stat(`${dir}/HEAD`), stat(`${dir}/objects`)]);
    return head.isFile() && objects.isDirectory();
  } catch {
    return false;
  }
}

export interface RepositorySource {
  gitUrl: string;
  /** The package owner (from the verified session or the package row). */
  ownerId: string;
  /** Required for SSH remotes; must be one of `ownerId`'s keys. */
  sshKeyId?: string | null;
  /** Links the package to the repository (owner-scoped update). */
  packageId?: string | null;
  isSnapshot?: boolean;
  repositoryId?: string | null;
}

/**
 * Find or create the repository row for a package's git URL, link the
 * package to it, and make sure the clone exists (cloning inline if needed).
 */
export async function ensureRepository(
  source: RepositorySource,
  options: CloneOptions = {},
  deps: GitLayerDeps = {},
): Promise<RepositoryRecord> {
  if (source.isSnapshot) return snapshotRepositoryFor(source, deps, { touch: options.touch });
  const remote = parseRemoteUrl(source.gitUrl);
  let ownerId: string | null = null;
  let sshKeyId: string | null = null;
  if (remote.kind === "ssh") {
    if (!source.sshKeyId) throw new RepoError("SSH_KEY_REQUIRED", "SSH remotes need an SSH key.");
    const key = await prisma.sshKey.findFirst({
      where: { id: source.sshKeyId, ownerId: source.ownerId },
      select: { id: true },
    });
    if (!key) throw new RepoError("SSH_KEY_NOT_FOUND", "SSH key not found.");
    ownerId = source.ownerId;
    sshKeyId = key.id;
  }
  const ownerScope = ownerId ?? "";
  const where = { remoteKey_ownerScope: { remoteKey: remote.remoteKey, ownerScope } };
  let repo: RepositoryRecord;
  try {
    repo = await prisma.repository.upsert({
      where,
      create: {
        remoteUrl: remote.remoteUrl,
        remoteKey: remote.remoteKey,
        visibility: ownerId ? "PRIVATE" : "PUBLIC",
        ownerId,
        ownerScope,
        sshKeyId,
      },
      // A PRIVATE row follows its package's current key.
      update: sshKeyId ? { sshKeyId } : {},
      select: repositorySelect,
    });
  } catch (error) {
    // Two first-time upserts raced on the unique key; the winner's row is there now.
    if (!isUniqueViolation(error)) throw error;
    repo = await prisma.repository.findUniqueOrThrow({ where, select: repositorySelect });
  }
  if (source.packageId) {
    await prisma.package.updateMany({
      // Only a package not already pointing here; `not` alone never matches NULL.
      where: {
        id: source.packageId,
        ownerId: source.ownerId,
        OR: [{ repositoryId: null }, { repositoryId: { not: repo.id } }],
      },
      data: { repositoryId: repo.id },
    });
  }
  return cloneRepository(repo.id, options, deps);
}

export interface CloneOptions {
  signal?: AbortSignal;
  privateKey?: string;
  /**
   * Record use (`lastUsedAt`) when the clone is already there. Default true;
   * `resolveTarget` passes false because it writes `lastUsedAt` itself once
   * the resolution succeeds.
   */
  touch?: boolean;
}

/**
 * Clone the repository if its bare clone is missing (first use, a failed
 * clone, or after pruning). A no-op for a READY row whose clone exists. The
 * clone goes to a staging directory and is renamed into place, so a crash
 * never leaves a half-written repository at the real path.
 */
export async function cloneRepository(
  repositoryId: string,
  options: CloneOptions = {},
  deps: GitLayerDeps = {},
): Promise<RepositoryRecord> {
  return withLock(
    repositoryLockKey(repositoryId),
    async () => {
      const repo = await loadRepository(repositoryId);
      const dir = repositoryDir(repo.id);
      if (repo.status === "READY" && (await isBareRepository(dir))) {
        if (options.touch === false) return repo;
        return prisma.repository.update({
          where: { id: repo.id },
          data: { lastUsedAt: now(deps) },
          select: repositorySelect,
        });
      }
      if (repo.isSnapshot && !options.privateKey) throw snapshotRefMissing();
      await ensureDataDirs();
      await prisma.repository.update({
        where: { id: repo.id },
        data: { status: "CLONING", lastError: null },
        select: { id: true },
      });
      const staging = `${dir}.clone-${randomBytes(6).toString("hex")}`;
      try {
        await removeInsideDataDir(dir);
        await withGitNetwork(
          { ...connectSpecFor(repo), privateKey: options.privateKey, signal: options.signal },
          (network) =>
            runGit(
              [
                "clone",
                "--bare",
                ...(repo.isSnapshot ? [] : ["--filter=blob:none"]),
                "--quiet",
                "--",
                repo.remoteUrl,
                staging,
              ],
              {
                cwd: reposRoot(),
                network,
                timeoutMs: CLONE_TIMEOUT_MS,
                signal: options.signal,
              },
            ),
          deps,
        );
        // A bare clone has no fetch refspec; map branches onto refs/heads so
        // `git fetch origin` keeps them current (tags follow automatically).
        await runGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], {
          gitDir: staging,
        });
        await rename(staging, dir);
        const defaultBranch = await readDefaultBranch(dir);
        const size = await (deps.measure ?? measureDirectory)(dir, { signal: options.signal });
        const at = now(deps);
        return await prisma.repository.update({
          where: { id: repo.id },
          data: {
            status: "READY",
            lastError: null,
            defaultBranch,
            diskBytes: size.bytes,
            lastFetchedAt: at,
            lastUsedAt: at,
          },
          select: repositorySelect,
        });
      } catch (error) {
        await removeInsideDataDir(staging).catch(() => {});
        await prisma.repository.update({
          where: { id: repo.id },
          data: {
            status: "FAILED",
            lastError: repo.isSnapshot ? "Snapshot operation failed." : lastErrorText(error),
          },
          select: { id: true },
        });
        throw repo.isSnapshot ? safeSnapshotError(error) : error;
      }
    },
    options.signal,
  );
}

/** No raw subprocess/IO error (or cause) can escape a request holding a pasted secret. */
export function safeSnapshotError(error: unknown): RepoError {
  return new RepoError(
    isRepoError(error) ? error.code : "GIT_FAILED",
    "Snapshot operation failed. Retry with your SSH key.",
    isRepoError(error) && error.code === "HOST_KEY_UNCONFIRMED"
      ? { host: error.details.host, port: error.details.port }
      : {},
  );
}

export function snapshotRefMissing(): RepoError {
  return new RepoError(
    "PACKAGE_SNAPSHOT_REF_MISSING",
    "This version is unavailable. The user must update the package in Cockpit Context with their SSH key.",
  );
}

async function snapshotRepositoryFor(
  pkg: { ownerId: string; repositoryId?: string | null },
  deps: GitLayerDeps,
  options: { touch?: boolean } = {},
): Promise<RepositoryRecord> {
  if (!pkg.repositoryId) throw snapshotRefMissing();
  const repo = await prisma.repository.findFirst({
    where: { id: pkg.repositoryId, ownerId: pkg.ownerId, isSnapshot: true },
    select: repositorySelect,
  });
  if (!repo) throw snapshotRefMissing();
  // Never a key here: a snapshot without its clone stays missing.
  return cloneRepository(repo.id, { touch: options.touch }, deps);
}

/** Fresh isolated private row, even for another package using the same remote. No secret is persisted. */
export async function createSnapshotRepository(
  source: { gitUrl: string; ownerId: string },
  privateKey: string,
  deps: GitLayerDeps = {},
): Promise<RepositoryRecord> {
  const remote = parseRemoteUrl(source.gitUrl);
  if (remote.kind !== "ssh") throw new RepoError("INVALID_REMOTE_URL", "Snapshots require SSH.");
  const repo = await prisma.repository.create({
    data: {
      remoteUrl: remote.remoteUrl,
      remoteKey: remote.remoteKey,
      ownerId: source.ownerId,
      ownerScope: `snapshot:${randomUUID()}`,
      visibility: "PRIVATE",
      isSnapshot: true,
    },
    select: repositorySelect,
  });
  try {
    return await cloneRepository(repo.id, { privateKey }, deps);
  } catch (error) {
    await deleteRepository(repo.id).catch(() => {});
    throw safeSnapshotError(error);
  }
}

/** Inline only: never enqueue the key. Both branches and all tags are fetched under the clone lock. */
export async function updateSnapshotRepository(
  repositoryId: string,
  ownerId: string,
  privateKey: string,
  deps: GitLayerDeps = {},
): Promise<RepositoryRecord> {
  const owned = await prisma.repository.findFirst({
    where: { id: repositoryId, ownerId, isSnapshot: true },
    select: repositorySelect,
  });
  if (!owned) throw snapshotRefMissing();
  await cloneRepository(repositoryId, { privateKey }, deps);
  return withLock(repositoryLockKey(repositoryId), async () => {
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, ownerId, isSnapshot: true },
      select: repositorySelect,
    });
    if (!repo) throw snapshotRefMissing();
    return fetchLocked(repo, "tags", { privateKey }, deps);
  });
}

export type FetchMode = "default" | "tags";

/** Parse `git ls-remote --symref origin HEAD` into a branch name. */
export function parseSymrefHead(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
    if (match?.[1] && isSafeRefName(match[1])) return match[1];
  }
  return null;
}

const MAX_LOGGED_TAGS = 20;
const CLOBBER_LINE = /^ ! \[rejected\]\s+\S+\s+->\s+(\S+)\s+\(would clobber existing tag\)$/;
/** A ref status line for an update that went through (new, fast-forward, forced, pruned, tag). */
const UPDATED_LINE = /^ [ *+=t-] /;

/**
 * The tags a `git fetch --tags` refused to move because they moved upstream
 * ("would clobber existing tag", git ≥ 2.20, exit 1), or null unless that is
 * the only thing wrong: every stderr line must be the `From` header, a ref
 * that updated, or such a rejection. Any other rejection, error or unknown
 * line is a real failure.
 */
export function clobberedTags(stderr: string): string[] | null {
  const tags: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const rejected = CLOBBER_LINE.exec(line);
    if (rejected?.[1]) {
      tags.push(rejected[1]);
      continue;
    }
    if (line.startsWith("From ") || UPDATED_LINE.test(line)) continue;
    return null;
  }
  return tags.length > 0 ? tags : null;
}

/**
 * Fetch one commit by id from the remote, with the repository lock already
 * held, through the same pinned network path as every fetch. Local git calls
 * cannot reach the remote (GIT_NO_NETWORK_CONFIG), so a full SHA missing from
 * the clone — on an unadvertised ref, or not yet fetched — is fetched here
 * explicitly. A commit the server does not have (or will not serve) is not an
 * error: returns false. Any other failure (timeout, network policy, SSH,
 * abort) is thrown. Snapshots never fetch without their key.
 */
export async function fetchCommitLocked(
  repo: RepositoryRecord,
  sha: string,
  options: { signal?: AbortSignal },
  deps: GitLayerDeps,
): Promise<boolean> {
  if (repo.isSnapshot) return false;
  const commit = assertFullSha(sha);
  const dir = repositoryDir(repo.id);
  if (!(await isBareRepository(dir))) return false;
  try {
    await withGitNetwork(
      { ...connectSpecFor(repo), signal: options.signal },
      (network) =>
        runGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", commit], {
          gitDir: dir,
          network,
          timeoutMs: FETCH_TIMEOUT_MS,
          signal: options.signal,
        }),
      deps,
    );
    return true;
  } catch (error) {
    // Only "the server has no such object" means the commit is not there. A
    // timeout, a refused/blocked host, an SSH key or host-key failure, or the
    // output cap is the real cause and must reach the caller as itself, not
    // as "was it force-pushed away?".
    if (!options.signal?.aborted && isMissingRemoteObject(error)) return false;
    throw error;
  }
}

/**
 * git's own words, on stderr, when the remote does not have (or will not
 * serve) an object asked for by id: upload-pack's "not our ref" (protocol v0
 * and v2), fetch-pack's refusal to ask for an unadvertised object, a missing
 * remote ref, and JGit's "want … not valid".
 */
const MISSING_REMOTE_OBJECT =
  /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|want [0-9a-f]+ not valid/i;

/**
 * A fetch by id that failed because the remote lacks the object: a plain
 * GIT_FAILED from git's own exit status (not an abort, the output cap or a
 * spawn failure, which carry no exit code) whose stderr says so. Connection,
 * authentication and host-key failures exit the same way (128) with other
 * words, so the exit code alone is not enough.
 */
function isMissingRemoteObject(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    error.code === "GIT_FAILED" &&
    error.exitCode !== null &&
    MISSING_REMOTE_OBJECT.test(error.stderr)
  );
}

/** Fetch with the repository lock already held. */
async function fetchLocked(
  repo: RepositoryRecord,
  mode: FetchMode,
  options: { signal?: AbortSignal; privateKey?: string },
  deps: GitLayerDeps,
): Promise<RepositoryRecord> {
  const dir = repositoryDir(repo.id);
  if (!(await isBareRepository(dir))) {
    throw new RepoError("REPOSITORY_NOT_FOUND", "The repository has not been cloned.");
  }
  let remoteHead: string | null = null;
  try {
    await withGitNetwork(
      { ...connectSpecFor(repo), privateKey: options.privateKey, signal: options.signal },
      async (network) => {
        // A tags fetch is not --quiet: its ref status lines are how a moved
        // tag (exit 1, "would clobber existing tag") is told apart from a
        // real failure.
        const args =
          mode === "tags"
            ? ["fetch", "--prune", "--tags", "origin"]
            : ["fetch", "--prune", "--quiet", "origin"];
        const runOptions = {
          gitDir: dir,
          network,
          timeoutMs: FETCH_TIMEOUT_MS,
          signal: options.signal,
          okExitCodes: mode === "tags" ? [1] : undefined,
        };
        const fetched = await runGit(args, runOptions);
        if (fetched.exitCode !== 0) {
          const moved = clobberedTags(fetched.stderr);
          if (!moved) throw gitFailure(args, fetched.exitCode, fetched.stderr, runOptions);
          // Everything else updated; the local tags stay where they were.
          console.warn(
            `[repos] fetch of ${repo.id} kept ${moved.length} local tag(s) that moved upstream: ${moved
              .slice(0, MAX_LOGGED_TAGS)
              .join(", ")}${moved.length > MAX_LOGGED_TAGS ? ", …" : ""}`,
          );
        }
        if (mode === "default" || repo.isSnapshot) {
          // The remote's default branch can change; follow it.
          const { stdout } = await runGit(["ls-remote", "--symref", "origin", "HEAD"], {
            gitDir: dir,
            network,
            timeoutMs: FETCH_TIMEOUT_MS,
            signal: options.signal,
          });
          remoteHead = parseSymrefHead(stdout);
        }
      },
      deps,
    );
  } catch (error) {
    await prisma.repository.update({
      where: { id: repo.id },
      data: { lastError: repo.isSnapshot ? "Snapshot operation failed." : lastErrorText(error) },
      select: { id: true },
    });
    throw repo.isSnapshot ? safeSnapshotError(error) : error;
  }
  if (remoteHead) {
    await runGit(["symbolic-ref", "HEAD", `refs/heads/${remoteHead}`], { gitDir: dir });
  }
  // Refs may have moved (a new tag can change how a version resolves): the
  // version→commit cache drops this repository's entries.
  notifyRepositoryChange(repo.id, "fetched");
  const size = await (deps.measure ?? measureDirectory)(dir, { signal: options.signal });
  return prisma.repository.update({
    where: { id: repo.id },
    data: {
      status: "READY",
      lastError: null,
      defaultBranch: await readDefaultBranch(dir),
      diskBytes: size.bytes,
      lastFetchedAt: now(deps),
    },
    select: repositorySelect,
  });
}

/** Fetch branches (`default`) or every tag (`tags`) from the remote. */
export async function fetchRepository(
  repositoryId: string,
  options: { mode?: FetchMode; signal?: AbortSignal } = {},
  deps: GitLayerDeps = {},
): Promise<RepositoryRecord> {
  const initial = await loadRepository(repositoryId);
  if (initial.isSnapshot) return initial;
  await cloneRepository(repositoryId, options, deps);
  const fetched = await withLock(
    repositoryLockKey(repositoryId),
    async () =>
      fetchLocked(await loadRepository(repositoryId), options.mode ?? "default", options, deps),
    options.signal,
  );
  // An explicit re-fetch: cached version resolutions and reused answers of
  // this repository are dropped (./repository-change-hooks.ts).
  notifyRepositoryChange(repositoryId, "refetched");
  return fetched;
}

/** Branch freshness policy: fetch when never fetched or older than COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS. */
export function isFetchStale(
  lastFetchedAt: Date | null,
  at: Date,
  intervalMs = fetchIntervalMs(),
): boolean {
  return !lastFetchedAt || at.getTime() - lastFetchedAt.getTime() >= intervalMs;
}

export interface ResolveTargetInput extends ResolveInput {
  package: ResolvePackageRecord;
  signal?: AbortSignal;
}

export interface ResolvedTarget extends Resolution {
  repositoryId: string;
  /** True when a refresh failed and local refs were used. */
  stale: boolean;
  /** Last successful remote fetch, including when returning stale refs. */
  fetchedAt: Date | null;
}

/**
 * Resolve a package's `version` or `ref` (or its default) to a commit SHA,
 * cloning and fetching as the fetch policy requires. The caller must already
 * have checked that the package belongs to the acting user.
 */
export async function resolveTarget(
  input: ResolveTargetInput,
  deps: GitLayerDeps = {},
): Promise<ResolvedTarget> {
  const pkg = input.package;
  // `touch: false`: lastUsedAt is written once, below, after a successful resolution.
  const repo = pkg.isSnapshot
    ? await snapshotRepositoryFor(pkg, deps, { touch: false })
    : await ensureRepository(
        { gitUrl: pkg.gitUrl, ownerId: pkg.ownerId, sshKeyId: pkg.sshKeyId, packageId: pkg.id },
        { signal: input.signal, touch: false },
        deps,
      );
  return withLock(
    repositoryLockKey(repo.id),
    async () => {
      let current = await loadRepository(repo.id);
      let stale = false;
      const refs = bareRepoRefs(repositoryDir(repo.id), {
        async fetchIfStale() {
          if (current.isSnapshot || !isFetchStale(current.lastFetchedAt, now(deps))) return;
          try {
            current = await fetchLocked(current, "default", { signal: input.signal }, deps);
          } catch (error) {
            input.signal?.throwIfAborted();
            stale = true;
            // Retain local refs and surface the failed refresh to the caller.
            console.warn(
              `[repos] fetch of ${current.id} failed; resolving against local refs`,
              error,
            );
          }
        },
        async fetchTags() {
          if (current.isSnapshot) return;
          current = await fetchLocked(current, "tags", { signal: input.signal }, deps);
        },
        async fetchCommit(sha) {
          await fetchCommitLocked(current, sha, { signal: input.signal }, deps);
        },
      });
      const ecosystem: ResolvablePackage["ecosystem"] = pkg.ecosystem;
      const resolution = await resolveInRepo(
        refs,
        { ecosystem, name: pkg.name, tagPattern: pkg.tagPattern, defaultRef: pkg.defaultRef },
        { version: input.version, ref: input.ref },
        {
          npmGitHead: current.isSnapshot
            ? undefined
            : (deps.npmGitHead ?? ((name, version) => fetchNpmGitHead(name, version))),
        },
      ).catch((error: unknown) => {
        if (
          current.isSnapshot &&
          isRepoError(error) &&
          ["REF_NOT_FOUND", "VERSION_NOT_FOUND"].includes(error.code)
        )
          throw snapshotRefMissing();
        throw error;
      });
      await prisma.repository.update({
        where: { id: repo.id },
        data: { lastUsedAt: now(deps) },
        select: { id: true },
      });
      await prisma.package.updateMany({
        where: { id: pkg.id, ownerId: pkg.ownerId, repositoryId: repo.id },
        data: { lastUsedAt: now(deps) },
      });
      return { ...resolution, repositoryId: repo.id, stale, fetchedAt: current.lastFetchedAt };
    },
    input.signal,
  );
}

/** Bound on checkouts considered per repository by measure/delete; far above real use. */
const MAX_CHECKOUTS_PER_REPOSITORY = 10_000;

/**
 * Delete a repository's clone, every checkout of it, and the row (checkouts
 * cascade; packages keep working and re-clone on demand). Refused while a run
 * holds a lease on any of its checkouts unless `force`.
 */
export async function deleteRepository(
  repositoryId: string,
  options: { force?: boolean } = {},
  deps: GitLayerDeps = {},
): Promise<{ freedBytes: bigint }> {
  return withLock(repositoryLockKey(repositoryId), async () => {
    const repo = await loadRepository(repositoryId);
    if (!options.force) {
      const leased = await prisma.checkoutLease.count({
        where: { Checkout: { repositoryId }, expiresAt: { gt: now(deps) } },
      });
      if (leased > 0) {
        throw new RepoError("CHECKOUT_LEASED", "A running investigation is using this repository.");
      }
    }
    const checkouts = await prisma.checkout.aggregate({
      where: { repositoryId },
      _sum: { diskBytes: true },
    });
    const doomed = await prisma.checkout.findMany({
      where: { repositoryId },
      select: { id: true },
      take: MAX_CHECKOUTS_PER_REPOSITORY,
    });
    await notifyCheckoutRemoval(doomed.map((row) => row.id));
    await removeInsideDataDir(repositoryCheckoutsDir(repositoryId));
    await removeInsideDataDir(repositoryDir(repositoryId));
    await prisma.repository.delete({ where: { id: repositoryId }, select: { id: true } });
    notifyRepositoryChange(repositoryId, "deleted");
    return { freedBytes: repo.diskBytes + (checkouts._sum.diskBytes ?? 0n) };
  });
}

export interface MeasureResult {
  repositoryBytes: bigint;
  checkouts: { id: string; bytes: bigint }[];
  totalBytes: bigint;
}

/**
 * Recompute `diskBytes` for a repository and each of its checkouts with the
 * bounded size walk, and store them. Missing directories measure as 0.
 */
export async function measure(
  repositoryId: string,
  options: { signal?: AbortSignal; privateKey?: string } = {},
  deps: GitLayerDeps = {},
): Promise<MeasureResult> {
  const sizeOf = deps.measure ?? measureDirectory;
  return withLock(
    repositoryLockKey(repositoryId),
    async () => {
      const repo = await loadRepository(repositoryId);
      const repoSize = await sizeOf(repositoryDir(repositoryId), { signal: options.signal });
      // Unchanged sizes are not rewritten: the hourly sweep mostly finds none.
      if (repo.diskBytes !== repoSize.bytes) {
        await prisma.repository.update({
          where: { id: repositoryId },
          data: { diskBytes: repoSize.bytes },
          select: { id: true },
        });
      }
      const rows = await prisma.checkout.findMany({
        where: { repositoryId },
        select: { id: true, sha: true, diskBytes: true },
        orderBy: { id: "asc" },
        take: MAX_CHECKOUTS_PER_REPOSITORY,
      });
      const checkouts: MeasureResult["checkouts"] = [];
      for (const row of rows) {
        const size = await sizeOf(checkoutDir(repositoryId, row.sha), { signal: options.signal });
        if (row.diskBytes !== size.bytes) {
          await prisma.checkout.update({
            where: { id: row.id },
            data: { diskBytes: size.bytes },
            select: { id: true },
          });
        }
        checkouts.push({ id: row.id, bytes: size.bytes });
      }
      const totalBytes = checkouts.reduce((sum, entry) => sum + entry.bytes, repoSize.bytes);
      return { repositoryBytes: repoSize.bytes, checkouts, totalBytes };
    },
    options.signal,
  );
}

/** Sum of the stored `diskBytes` of every clone and checkout. */
export async function totalStorageBytes(): Promise<bigint> {
  const [repos, checkouts] = await Promise.all([
    prisma.repository.aggregate({ _sum: { diskBytes: true } }),
    prisma.checkout.aggregate({ _sum: { diskBytes: true } }),
  ]);
  return (repos._sum.diskBytes ?? 0n) + (checkouts._sum.diskBytes ?? 0n);
}
