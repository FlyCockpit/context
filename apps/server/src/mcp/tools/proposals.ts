import {
  consumePackageWriteBudget,
  consumeRegistryLookupBudget,
  ecosystemSchema,
  insertPackage,
  lower,
  normalizeNameOrThrow,
  validatePackageSource,
} from "@cockpit-context/api/lib/packages";
import prisma, { type Prisma } from "@cockpit-context/db";
import { env } from "@cockpit-context/env/server";
import {
  type Ecosystem,
  lookupRegistry,
  normalizePackageName,
  packageIdentifier,
  parseRemoteUrl,
  toStoredEcosystem,
} from "@cockpit-context/repos";
import { z } from "zod";

import type { McpIdentity } from "../credentials";
import { defineTool, McpToolError } from "./types";

/**
 * `propose_dependency` and `get_proposal` (docs/product.md). Both are listed and callable only for a connection whose
 * propose flag is on (`requiresPropose`). A proposal waits for the owner's
 * decision unless the connection auto-approves; one that needs an SSH key
 * (or whose source does not validate) always waits.
 *
 * An agent can never approve: auto-approve is the person's setting on the
 * connection, read from the credential row.
 */

const MAX_REASON_LENGTH = 2_000;

/**
 * Pending proposals one user may have at once, across all of their
 * connections (`COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER`, default 100). Each is
 * a row the person has to review; past this an agent has to wait for
 * decisions instead of queueing more. Read per call, like the budgets.
 */
function maxPendingProposalsPerUser(): number {
  return env.COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER;
}

/**
 * Process-local keyed mutex (Cockpit Context runs one app replica, docs/hosting.md).
 * `propose_dependency` holds it from its duplicate checks through its create,
 * so concurrent calls for the same owner cannot exceed the pending cap,
 * even when they propose different identifiers. Duplicate checks run under
 * the same lock, after any preceding proposal has been inserted.
 */
const proposalLocks = new Map<string, Promise<void>>();

async function withProposalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = proposalLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  proposalLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (proposalLocks.get(key) === tail) proposalLocks.delete(key);
  }
}

const proposeInput = z.object({
  ecosystem: ecosystemSchema,
  name: z.string().trim().min(1).max(300),
  git_url: z.string().trim().min(1).max(2_048).optional(),
  version: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
});

const getProposalInput = z.object({ proposal_id: z.string().trim().min(1).max(64) });

const proposalSelect = {
  id: true,
  status: true,
  identifier: true,
  rejectionReason: true,
  packageId: true,
} satisfies Prisma.PackageProposalSelect;

type ProposalRow = Prisma.PackageProposalGetPayload<{ select: typeof proposalSelect }>;

function serializeProposal(row: ProposalRow) {
  const status = lower(row.status);
  return {
    proposal_id: row.id,
    status,
    identifier: row.identifier,
    ...(status === "rejected" ? { rejection_reason: row.rejectionReason } : {}),
    message:
      status === "pending"
        ? "Waiting for the user to approve it in Cockpit Context. Call get_proposal later to check."
        : status === "approved"
          ? `Approved: query_dependency can now use ${row.identifier}.`
          : "The user rejected this proposal.",
  };
}

function connectionColumns(identity: McpIdentity) {
  return identity.credential.kind === "agent_token"
    ? { mcpAgentTokenId: identity.credential.tokenId, connectionLabel: identity.label }
    : { mcpGrantId: identity.credential.grantId, connectionLabel: identity.label };
}

type Suggestion = {
  gitUrl: string | null;
  displayName: string | null;
  subdirectory: string | null;
};

const NO_SUGGESTION: Suggestion = { gitUrl: null, displayName: null, subdirectory: null };

/**
 * The registry's suggestion, charged to the same per-user registry-lookup
 * budget as the web's `packages.lookupRegistry`. Over budget (or the budget
 * unavailable) means no suggestion: the proposal is still made, and the
 * person fills in the git URL when they review it.
 */
async function suggestionFor(
  ownerId: string,
  ecosystem: Ecosystem,
  name: string,
): Promise<Suggestion> {
  if (ecosystem === "git") return NO_SUGGESTION;
  try {
    await consumeRegistryLookupBudget(`user:${ownerId}`);
  } catch {
    return NO_SUGGESTION;
  }
  const result = await lookupRegistry({ ecosystem, name });
  if (result.status !== "found") return NO_SUGGESTION;
  return {
    gitUrl: result.suggestion.gitUrl,
    displayName: result.suggestion.displayName,
    subdirectory: result.suggestion.subdirectory,
  };
}

/**
 * Creates the package now for an auto-approving connection, or returns null
 * when it must wait for the owner: an SSH source, a source that fails
 * validation, or an exhausted write budget all leave the proposal pending.
 */
async function tryAutoApprove(
  ownerId: string,
  draft: {
    ecosystem: Ecosystem;
    name: string;
    gitUrl: string;
    displayName: string | null;
    subdirectory: string | null;
  },
): Promise<{ id: string; identifier: string } | null> {
  if (!/^https:\/\//i.test(draft.gitUrl)) return null;
  try {
    await consumePackageWriteBudget(`user:${ownerId}`);
    const source = await validatePackageSource(ownerId, { gitUrl: draft.gitUrl, sshKeyId: null });
    if (source.sshKeyId !== null) return null;
    const created = await insertPackage(prisma, ownerId, {
      ecosystem: draft.ecosystem,
      name: draft.name,
      displayName: draft.displayName ?? undefined,
      gitUrl: source.gitUrl,
      sshKeyId: null,
      subdirectory: draft.subdirectory,
    });
    return { id: created.id, identifier: created.identifier };
  } catch {
    // Any refusal (invalid or private URL, budget, a racing duplicate) is a
    // decision for the person, not the agent.
    return null;
  }
}

/** Agent-supplied URLs need independent provenance before auto-approval. */
function sourceMayAutoApprove(
  input: z.output<typeof proposeInput>,
  name: string,
  registryUrl: string | null,
): boolean {
  if (!input.git_url) return true;
  try {
    const expected =
      input.ecosystem === "git"
        ? // An owner/repo name has no host to corroborate. It requires review.
          name.split("/").length >= 3 && name.split("/")[0]?.includes(".")
          ? `https://${name}`
          : null
        : registryUrl;
    return (
      expected !== null &&
      parseRemoteUrl(input.git_url).remoteKey === parseRemoteUrl(expected).remoteKey
    );
  } catch {
    return false;
  }
}

export async function runProposeDependency(
  input: z.output<typeof proposeInput>,
  identity: McpIdentity,
) {
  const ownerId = identity.userId;
  if (normalizePackageName(input.ecosystem, input.name) === null) {
    throw new McpToolError(
      "INVALID_PACKAGE_NAME",
      `"${input.name.slice(0, 200)}" is not a valid ${input.ecosystem} package name.${
        input.ecosystem === "git" ? " git names are owner/repo paths." : ""
      }`,
    );
  }
  const name = normalizeNameOrThrow(input.ecosystem, input.name);
  const identifier = packageIdentifier(input.ecosystem, name);
  return withProposalLock(ownerId, () => proposeLocked(input, identity, name, identifier));
}

async function proposeLocked(
  input: z.output<typeof proposeInput>,
  identity: McpIdentity,
  name: string,
  identifier: string,
) {
  const ownerId = identity.userId;
  const existing = await prisma.package.findFirst({
    where: { ownerId, identifier },
    select: { id: true },
  });
  if (existing) {
    return {
      status: "exists" as const,
      identifier,
      message: `${identifier} is already in the user's Cockpit Context list; call query_dependency.`,
    };
  }
  const pending = await prisma.packageProposal.findFirst({
    where: { ownerId, identifier, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: proposalSelect,
  });
  if (pending) return serializeProposal(pending);

  // Checked before the registry lookup, so a capped call spends nothing.
  // The owner-scoped lock covers this count through the insert.
  const pendingCount = await prisma.packageProposal.count({
    where: { ownerId, status: "PENDING" },
  });
  const maxPending = maxPendingProposalsPerUser();
  if (pendingCount >= maxPending) {
    throw new McpToolError(
      "PROPOSAL_LIMIT",
      `The user already has ${maxPending} proposals waiting for a decision. Do not propose more until they approve or reject some in Cockpit Context; call get_proposal to check on the ones you made.`,
      { max_pending: maxPending },
    );
  }

  const suggestion = await suggestionFor(ownerId, input.ecosystem, name);
  const gitUrl = input.git_url ?? suggestion.gitUrl;
  const base = {
    ownerId,
    ecosystem: toStoredEcosystem(input.ecosystem),
    name,
    identifier,
    displayName: suggestion.displayName,
    gitUrl,
    subdirectory: suggestion.subdirectory,
    version: input.version ?? null,
    reason: input.reason,
    ...connectionColumns(identity),
  };

  if (identity.autoApprove && gitUrl && sourceMayAutoApprove(input, name, suggestion.gitUrl)) {
    const created = await tryAutoApprove(ownerId, {
      ecosystem: input.ecosystem,
      name,
      gitUrl,
      displayName: suggestion.displayName,
      subdirectory: suggestion.subdirectory,
    });
    if (created) {
      const row = await prisma.packageProposal.create({
        data: { ...base, status: "APPROVED", decidedAt: new Date(), packageId: created.id },
        select: proposalSelect,
      });
      return serializeProposal(row);
    }
  }

  const row = await prisma.packageProposal.create({ data: base, select: proposalSelect });
  return serializeProposal(row);
}

export async function runGetProposal(input: z.output<typeof getProposalInput>, ownerId: string) {
  const row = await prisma.packageProposal.findFirst({
    where: { id: input.proposal_id, ownerId },
    select: proposalSelect,
  });
  if (!row) {
    throw new McpToolError(
      "PROPOSAL_NOT_FOUND",
      "No proposal with that proposal_id. Use the proposal_id that propose_dependency returned.",
    );
  }
  return serializeProposal(row);
}

export const proposeDependencyTool = defineTool({
  name: "propose_dependency",
  description: [
    "Propose adding a dependency to the user's Cockpit Context list when list_dependencies does not have one the project uses.",
    "A human must approve it in Cockpit Context before query_dependency can use it (unless the user set this connection to auto-approve).",
    "Give the ecosystem (npm, pypi, cargo, go or git), the registry name, and a short reason; Cockpit Context looks up the git URL from the registry when you leave git_url out.",
  ].join(" "),
  input: proposeInput,
  requiresPropose: true,
  run: (input, ctx) => runProposeDependency(input, ctx.identity),
});

export const getProposalTool = defineTool({
  name: "get_proposal",
  description:
    "Check a proposal made with propose_dependency: pending, approved (with the identifier to query) or rejected (with the user's reason).",
  input: getProposalInput,
  requiresPropose: true,
  run: (input, ctx) => runGetProposal(input, ctx.identity.userId),
});
