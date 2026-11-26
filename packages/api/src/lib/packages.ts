import prisma, { type Prisma } from "@cockpit-context/db";
import {
  createSnapshotRepositoryRow,
  deleteRepository,
  ECOSYSTEMS,
  type Ecosystem,
  fromStoredEcosystem,
  importSshKey,
  isSafeRefName,
  normalizeImportedPrivateKey,
  normalizePackageName,
  packageIdentifier,
  RepoError,
  resolutionCache,
  safeSnapshotError,
  toStoredEcosystem,
  validateRemoteUrl,
} from "@cockpit-context/repos";
import { repositoryFailureReason } from "@cockpit-context/repos/errors";
import { invalidateAnswersForPackage } from "@cockpit-context/runs/answer-reuse";
import { z } from "zod";

import { reasonError, withDomainErrors } from "./domain-errors";
import { findOwnedOrThrow } from "./ownership";
import { createProcedureBudget } from "./procedure-budget";
import { cockpitContextRateBudget } from "./rate-budgets";
import { entityId, longText, shortText } from "./schemas";
import { startSnapshotSync } from "./snapshot-tasks";
import { consumeKeyWriteBudget, pastedSshKeySchema } from "./ssh-key-input";

/**
 * Package creation and validation shared by `packages.create`,
 * `proposals.approve` and the MCP server's auto-approve path
 * (docs/product.md). Every function takes the owner id from the
 * verified session (or the MCP credential), never from input.
 */

/**
 * One point per create or edit that saves a git URL. Each one resolves the
 * URL's host in DNS (the private-address check), so this bounds the DNS
 * lookups one account can trigger. The default 60 per 10 minutes
 * (`COCKPIT_CONTEXT_PACKAGE_WRITES_PER_10_MINUTES`) is far above anyone
 * curating a dependency list by hand. Shared by `packages.create`,
 * `packages.update` and `proposals.approve` (one bucket per user).
 */
export const consumePackageWriteBudget = createProcedureBudget({
  keyPrefix: "rl:packages-write",
  budget: () => cockpitContextRateBudget("packageWrite"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many package changes. Try again in ${seconds}s.`,
  unavailableMessage: "Saving packages is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[packages] write budget unavailable, failing closed:",
});

/**
 * One point per registry lookup: an outbound HTTPS request to a fixed
 * registry host. The default 60 per 5 minutes
 * (`COCKPIT_CONTEXT_REGISTRY_LOOKUPS_PER_5_MINUTES`) covers looking up a dozen packages with
 * retries; fail-closed because each point is outbound traffic on user input.
 * Shared by `packages.lookupRegistry` and the MCP `propose_dependency` tool
 * (one bucket per user, keyed `user:<id>`, whichever surface asks).
 */
export const consumeRegistryLookupBudget = createProcedureBudget({
  keyPrefix: "rl:packages-registry-lookup",
  budget: () => cockpitContextRateBudget("registryLookup"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many registry lookups. Try again in ${seconds}s.`,
  unavailableMessage: "Registry lookup is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[packages] registry lookup budget unavailable, failing closed:",
});

export const ecosystemSchema = z.enum(ECOSYSTEMS);

const MAX_SUBDIRECTORY = 300;

/** A repository-relative directory: no leading `/`, no `.`/`..` segments. */
export const subdirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUBDIRECTORY)
  .transform((value) => value.replace(/\/+$/, ""))
  .refine(
    (value) =>
      /^[A-Za-z0-9._@+/-]+$/.test(value) &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "Must be a relative path inside the repository" },
  );

/** A tag template with a `{version}` placeholder, e.g. `@tanstack/react-query@{version}`. */
export const tagPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) => value.includes("{version}") && isSafeRefName(value.replaceAll("{version}", "1.0.0")),
    {
      message: "Must contain {version} and form a valid tag name",
    },
  );

export const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .refine(isSafeRefName, { message: "Not a valid tag, branch or commit name" });

export const gitUrlSchema = z.string().trim().min(1).max(2_048);

/** The editable fields of a package, as the create/approve forms send them. */
export const packageFieldsSchema = z.object({
  displayName: shortText.optional(),
  gitUrl: gitUrlSchema,
  sshKeyId: entityId.nullish(),
  oneTimeKey: pastedSshKeySchema.optional(),
  subdirectory: subdirectorySchema.nullish(),
  tagPattern: tagPatternSchema.nullish(),
  defaultRef: refSchema.nullish(),
  notes: longText.nullish(),
});

export type PackageFields = z.infer<typeof packageFieldsSchema>;

export interface PackageDraft extends PackageFields {
  ecosystem: Ecosystem;
  /** Raw registry name; normalized here. */
  name: string;
}

/** Normalize a name for its ecosystem or fail with `INVALID_PACKAGE_NAME`. */
export function normalizeNameOrThrow(ecosystem: Ecosystem, name: string): string {
  const normalized = normalizePackageName(ecosystem, name);
  if (normalized === null) {
    throw reasonError(
      "BAD_REQUEST",
      "INVALID_PACKAGE_NAME",
      "That is not a valid package name for this ecosystem.",
    );
  }
  return normalized;
}

/**
 * Validate a git URL (syntax, then a DNS check that the host is public) and
 * the SSH key it needs. SSH remotes require one of the owner's keys; HTTPS
 * remotes never use a key, so a key sent with one is dropped.
 */
export async function validatePackageSource(
  ownerId: string,
  source: { gitUrl: string; sshKeyId?: string | null },
): Promise<{ gitUrl: string; sshKeyId: string | null }> {
  const parsed = await withDomainErrors(() => validateRemoteUrl(source.gitUrl));
  if (parsed.kind === "https") return { gitUrl: parsed.remoteUrl, sshKeyId: null };
  if (!source.sshKeyId) {
    throw reasonError("BAD_REQUEST", "SSH_KEY_REQUIRED", "SSH git URLs need an SSH key.");
  }
  const key = await findOwnedOrThrow({
    find: (args) => prisma.sshKey.findFirst(args),
    args: { where: { id: source.sshKeyId }, select: { id: true } },
    owner: { field: "ownerId", id: ownerId },
    notFound: "SSH key not found.",
  });
  return { gitUrl: parsed.remoteUrl, sshKeyId: key.id };
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

export function packageExistsError() {
  return reasonError("CONFLICT", "PACKAGE_EXISTS", "You already have a package with that name.");
}

/** Client-facing package projection. Never includes another user's data. */
export const packageViewSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  identifier: true,
  ecosystem: true,
  name: true,
  displayName: true,
  gitUrl: true,
  subdirectory: true,
  tagPattern: true,
  defaultRef: true,
  lastUsedAt: true,
  isSnapshot: true,
  SshKey: { select: { id: true, name: true, fingerprint: true } },
  Repository: {
    select: {
      id: true,
      status: true,
      visibility: true,
      defaultBranch: true,
      lastFetchedAt: true,
      // Read only to classify a failure (`failureReason`); never sent.
      lastError: true,
      snapshotSyncStatus: true,
      snapshotSyncError: true,
      snapshotSyncStartedAt: true,
    },
  },
} satisfies Prisma.PackageSelect;

export type PackageViewRow = Prisma.PackageGetPayload<{ select: typeof packageViewSelect }>;

export function serializePackage(row: PackageViewRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    identifier: row.identifier,
    ecosystem: fromStoredEcosystem(row.ecosystem),
    name: row.name,
    displayName: row.displayName,
    gitUrl: row.gitUrl,
    subdirectory: row.subdirectory,
    tagPattern: row.tagPattern,
    defaultRef: row.defaultRef,
    lastUsedAt: row.lastUsedAt,
    isSnapshot: row.isSnapshot,
    sshKey: row.SshKey
      ? { id: row.SshKey.id, name: row.SshKey.name, fingerprint: row.SshKey.fingerprint }
      : null,
    repository: row.Repository
      ? {
          id: row.Repository.id,
          status: lower(row.Repository.status),
          visibility: lower(row.Repository.visibility),
          defaultBranch: row.Repository.defaultBranch,
          lastFetchedAt: row.Repository.lastFetchedAt,
          /** Why the last clone or fetch failed (a fixed reason, never git output); null unless `failed`. */
          failureReason:
            row.Repository.status === "FAILED"
              ? repositoryFailureReason(row.Repository.lastError)
              : null,
          /**
           * A snapshot's background clone or refresh with a pasted key:
           * `running`, `failed` (with the RepoError code, never git output)
           * or `none`. Always `none` for other repositories.
           */
          snapshotSync: {
            status: lower(row.Repository.snapshotSyncStatus),
            error: row.Repository.snapshotSyncError,
            startedAt: row.Repository.snapshotSyncStartedAt,
          },
        }
      : null,
  };
}

/** Stored SCREAMING_SNAKE_CASE enum → the API's lowercase spelling. */
export function lower<T extends string>(value: T): Lowercase<T> {
  return value.toLowerCase() as Lowercase<T>;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Create a package for `ownerId` from an already-validated draft (call
 * {@link validatePackageSource} first; it does network I/O, so keep it out of
 * transactions). A duplicate identifier is `CONFLICT` / `PACKAGE_EXISTS`.
 */
export async function insertPackage(
  db: Db,
  ownerId: string,
  draft: Omit<PackageDraft, "gitUrl" | "sshKeyId"> & {
    gitUrl: string;
    sshKeyId: string | null;
    isSnapshot?: boolean;
    repositoryId?: string;
  },
): Promise<PackageViewRow> {
  const name = normalizeNameOrThrow(draft.ecosystem, draft.name);
  try {
    return await db.package.create({
      data: {
        ownerId,
        identifier: packageIdentifier(draft.ecosystem, name),
        ecosystem: toStoredEcosystem(draft.ecosystem),
        name,
        displayName: draft.displayName ?? name,
        gitUrl: draft.gitUrl,
        sshKeyId: draft.sshKeyId,
        isSnapshot: draft.isSnapshot ?? false,
        repositoryId: draft.repositoryId,
        subdirectory: draft.subdirectory ?? null,
        tagPattern: draft.tagPattern ?? null,
        defaultRef: draft.defaultRef ?? null,
        notes: draft.notes ?? null,
      },
      select: packageViewSelect,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw packageExistsError();
    throw error;
  }
}

/** Validate and create in one call: the path for a plain create. */
export async function createPackageForOwner(
  ownerId: string,
  draft: PackageDraft,
): Promise<PackageViewRow> {
  normalizeNameOrThrow(draft.ecosystem, draft.name);
  const source = await preparePackageSource(ownerId, draft);
  let row: PackageViewRow;
  try {
    row = await insertPackage(prisma, ownerId, { ...draft, ...source });
  } catch (error) {
    await discardPreparedSnapshot(source);
    throw error;
  }
  await startPreparedSnapshot(source);
  return row;
}

/** Human-only create/approve source preparation; MCP calls never accept oneTimeKey. */
export async function preparePackageSource(
  ownerId: string,
  source: {
    gitUrl: string;
    sshKeyId?: string | null;
    oneTimeKey?: z.infer<typeof pastedSshKeySchema>;
  },
): Promise<{
  gitUrl: string;
  sshKeyId: string | null;
  isSnapshot?: boolean;
  repositoryId?: string;
}> {
  const key = source.oneTimeKey;
  if (!key) return validatePackageSource(ownerId, source);
  await consumeKeyWriteBudget(`user:${ownerId}`);
  return withDomainErrors(async () => {
    try {
      const remote = await validateRemoteUrl(source.gitUrl);
      if (remote.kind !== "ssh")
        throw new RepoError("INVALID_REMOTE_URL", "Pasted keys require SSH.");
      if (key.save) {
        const saved = await importSshKey({
          ownerId,
          name: key.name!,
          privateKey: key.privateKey,
          passphrase: key.passphrase,
        });
        return { gitUrl: remote.remoteUrl, sshKeyId: saved.id };
      }
      const normalized = await normalizeImportedPrivateKey(
        key.privateKey,
        key.passphrase || undefined,
      );
      // Only the row now; the clone runs in the background once the package
      // exists (startPreparedSnapshot), so this request never waits for it.
      const repo = await createSnapshotRepositoryRow({ gitUrl: remote.remoteUrl, ownerId });
      const prepared = {
        gitUrl: remote.remoteUrl,
        sshKeyId: null,
        isSnapshot: true,
        repositoryId: repo.id,
      };
      const privateKey = normalized.privateKey;
      pendingSnapshotClones.set(prepared, () =>
        startSnapshotSync({
          repositoryId: repo.id,
          ownerId,
          privateKey,
          kind: "clone",
        }).then(() => {}),
      );
      return prepared;
    } catch (error) {
      throw safeSnapshotError(error);
    }
  });
}

/**
 * Prepared snapshot sources → the start of their background clone. The key
 * lives only in that closure: never on the source object, which callers
 * spread into package rows.
 */
const pendingSnapshotClones = new WeakMap<object, () => Promise<void>>();

/**
 * After the package row exists: start the prepared snapshot's background
 * clone (no-op for any other source). It never throws: a start that fails
 * leaves the snapshot FAILED for the package page to offer a retry.
 */
export async function startPreparedSnapshot(source: object): Promise<void> {
  const start = pendingSnapshotClones.get(source);
  if (!start) return;
  pendingSnapshotClones.delete(source);
  const { repositoryId } = source as { repositoryId?: string };
  try {
    await start();
  } catch (error) {
    console.warn(`[snapshots] could not start the clone of ${repositoryId}`, error);
    if (repositoryId) {
      await prisma.repository
        .updateMany({
          where: { id: repositoryId },
          data: { snapshotSyncStatus: "FAILED", snapshotSyncError: "GIT_FAILED" },
        })
        .catch(() => {});
    }
  }
}

export async function discardPreparedSnapshot(source: {
  isSnapshot?: boolean;
  repositoryId?: string;
}) {
  pendingSnapshotClones.delete(source);
  if (source.isSnapshot && source.repositoryId)
    await deleteRepository(source.repositoryId).catch(() => {});
}

/**
 * A package's resolution inputs or the text its investigations read (notes,
 * subdirectory, source, snapshot) changed, or it is gone: drop its cached
 * version resolutions and reused MCP answers (docs/mcp.md § Answer reuse).
 */
export function forgetPackageReuse(packageId: string): void {
  resolutionCache.invalidatePackage(packageId);
  invalidateAnswersForPackage(packageId);
}
