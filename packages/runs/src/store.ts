import type { AgentMessagePart } from "@cockpit-context/agent-runtime";
import prisma, { type Prisma } from "@cockpit-context/db";
import { withRepositoryLock } from "@cockpit-context/repos";

import type { RunKind, RunStatus, TurnRole } from "./events";
import { summarizeCheckoutJob } from "./job-definitions";

/**
 * The run engine's persistence boundary. The engine talks to Postgres only
 * through this interface, so its tests run against an in-memory store
 * (`test-support/memory-run-store.ts`) and the Prisma implementation below is
 * tested on its own against a mocked client.
 *
 * Every read that starts from user input is scoped by `ownerId`.
 */

export type RunTrigger = "mcp_query" | "web_message" | "summary";
export type ConversationOrigin = "mcp" | "web";
export type SummaryStatus = "none" | "pending" | "ready" | "failed";

export interface PackageForRun {
  id: string;
  ownerId: string;
  identifier: string;
  ecosystem: "NPM" | "PYPI" | "CARGO" | "GO" | "GIT";
  name: string;
  gitUrl: string;
  sshKeyId: string | null;
  isSnapshot: boolean;
  repositoryId: string | null;
  tagPattern: string | null;
  defaultRef: string | null;
  subdirectory: string | null;
  notes: string | null;
}

export interface ConversationForRun {
  id: string;
  ownerId: string;
  packageId: string | null;
  packageIdentifier: string;
  requestedVersion: string | null;
  requestedRef: string | null;
  checkoutId: string | null;
  commitSha: string | null;
  resolvedFrom: string | null;
}

export interface NewConversation {
  ownerId: string;
  packageId: string;
  packageIdentifier: string;
  requestedVersion: string | null;
  requestedRef: string | null;
  checkoutId: string;
  commitSha: string;
  resolvedFrom: string;
  origin: ConversationOrigin;
  mcpAgentTokenId: string | null;
  mcpGrantId: string | null;
  mcpConnectionLabel: string | null;
  title: string;
}

export interface NewRun {
  ownerId: string;
  conversationId: string | null;
  parentRunId: string | null;
  checkoutId: string | null;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  model: string | null;
  focus: string | null;
  startedAt: Date | null;
}

export interface RunUpdate {
  status?: RunStatus;
  checkoutId?: string;
  stopReason?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsdMicros?: number;
  iterations?: number;
  startedAt?: Date;
  finishedAt?: Date;
  answer?: string | null;
}

export interface NewTurn {
  runId: string;
  seq: number;
  role: TurnRole;
  parts: AgentMessagePart[];
  steering: boolean;
}

export interface StoredTurn {
  id: string;
  runId: string;
  seq: number;
  role: TurnRole;
  parts: AgentMessagePart[];
  steering: boolean;
}

export interface CheckoutForRun {
  id: string;
  repositoryId: string;
  sha: string;
  status: "pending" | "ready" | "failed";
  repoMap: unknown;
  /** The model-written (generated) overview; never a user's edit. */
  summary: string | null;
  summaryStatus: SummaryStatus;
}

interface SummaryTarget extends CheckoutForRun {
  remoteKey: string;
}

export interface RunRecord {
  id: string;
  conversationId: string | null;
  kind: RunKind;
  status: RunStatus;
  stopReason: string | null;
  error: string | null;
  answer: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsdMicros: number;
}

export interface RunStore {
  loadPackage(ownerId: string, packageId: string): Promise<PackageForRun | null>;
  createConversation(data: NewConversation): Promise<ConversationForRun>;
  loadConversation(ownerId: string, conversationId: string): Promise<ConversationForRun | null>;
  /** The conversation's newest MAIN run, if any. */
  latestMainRun(conversationId: string): Promise<{ id: string; status: RunStatus } | null>;
  updateConversation(
    conversationId: string,
    data: { checkoutId?: string; lastActivityAt?: Date },
  ): Promise<void>;
  createRun(data: NewRun): Promise<{ id: string }>;
  updateRun(runId: string, data: RunUpdate): Promise<void>;
  /**
   * `updateRun`, only while the run is still queued/running: the last-resort
   * terminal write, which must never overwrite a run already finished.
   * `false` when nothing matched (already terminal, or gone).
   */
  finishRunIfActive(runId: string, data: RunUpdate): Promise<boolean>;
  /**
   * Close the still queued/running HELPER runs of `parentRunId` (their own
   * terminal write failed) as their main run ends. `excludeIds` are helpers
   * still executing in this process: they write their own terminal status.
   * Returns how many moved.
   */
  closeActiveHelpers(
    parentRunId: string,
    data: {
      status: RunStatus;
      stopReason: string | null;
      error: string | null;
      finishedAt: Date;
    },
    excludeIds?: readonly string[],
  ): Promise<number>;
  getRun(ownerId: string, runId: string): Promise<RunRecord | null>;
  insertTurn(turn: NewTurn): Promise<void>;
  /**
   * Turns of the conversation's finished MAIN runs, oldest run first, by seq.
   * Capped at the newest {@link MAX_HISTORY_TURNS}: a follow-up needs the
   * latest turns most, and `historyFromTurns` drops a tool result whose call
   * fell outside the cap.
   */
  listHistoryTurns(conversationId: string): Promise<StoredTurn[]>;
  /** Find or create the checkout row for (repository, sha); does not touch the disk. */
  upsertCheckout(repositoryId: string, sha: string, resolvedFrom: string | null): Promise<string>;
  loadCheckout(checkoutId: string): Promise<CheckoutForRun | null>;
  /** Only the checkout's materialization status (no repo map, no summary). */
  loadCheckoutStatus(checkoutId: string): Promise<CheckoutForRun["status"] | null>;
  loadSummaryTarget(checkoutId: string): Promise<SummaryTarget | null>;
  /**
   * `true` when `ownerId` has a package on the checkout's repository (that
   * package, when `packageId` is given). The ownership gate of a summary request.
   */
  ownsCheckout(ownerId: string, checkoutId: string, packageId?: string): Promise<boolean>;
  /**
   * `false` when the account no longer exists or is archived (an unexpired
   * ban): its runs must not start (`RunEngine.stopAllForOwner`).
   */
  ownerMayRun(ownerId: string): Promise<boolean>;
  /**
   * `ownerId`'s own edited overview of the checkout (CheckoutSummaryOverride),
   * or null. Keyed on the run's owner: nobody else's edit is ever read.
   */
  loadSummaryOverride(checkoutId: string, ownerId: string): Promise<string | null>;
  saveRepoMap(checkoutId: string, repoMap: Prisma.InputJsonValue): Promise<void>;
  /** `false` when the checkout row no longer exists (pruned under us). */
  acquireLease(runId: string, checkoutId: string, expiresAt: Date): Promise<boolean>;
  releaseLeases(runId: string): Promise<void>;
  /**
   * Recovery: every queued/running run not in `liveRunIds` becomes
   * interrupted, and every lease of a run not in `liveRunIds` is released.
   * At boot nothing is live, so this covers every run and lease.
   * A checkout whose PENDING summary belonged to one of those SUMMARY runs
   * goes back to NONE (its single-attempt job is gone), so the next run that
   * reads the checkout requests it again.
   */
  interruptOrphanRuns(finishedAt: Date, liveRunIds: string[]): Promise<number>;
  /**
   * Recovery, after `interruptOrphanRuns`: every PENDING summary that nothing
   * will finish (no queued/running SUMMARY run, and no `checkout.summarize`
   * job that will still run) goes back to NONE, so the next run that reads
   * the checkout requests it again. Returns how many moved.
   */
  resetOrphanSummaries(): Promise<number>;
  /**
   * Move the generated summary to PENDING if it is in one of `from`; `true`
   * when it moved. The previous generated text stays readable meanwhile, and
   * users' overrides are never touched.
   */
  markSummaryPending(checkoutId: string, from: SummaryStatus[]): Promise<boolean>;
  /** Finish a PENDING summary; `false` when it is no longer PENDING (finished elsewhere). */
  finishSummary(
    checkoutId: string,
    data:
      | { status: "ready"; summary: string; model: string; generatedAt: Date }
      | { status: "failed" | "none" },
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Boundary mapping. Stored enums are SCREAMING_SNAKE_CASE
// (docs/development.md); the engine speaks the lowercase API spellings.
// ---------------------------------------------------------------------------

type DbRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED" | "INTERRUPTED";
type DbRunKind = "MAIN" | "HELPER" | "SUMMARY";
type DbSummaryStatus = "NONE" | "PENDING" | "READY" | "FAILED";
type DbTurnRole = "USER" | "ASSISTANT" | "TOOL";

const toDbStatus = (status: RunStatus): DbRunStatus => status.toUpperCase() as DbRunStatus;
const fromDbStatus = (status: DbRunStatus): RunStatus => status.toLowerCase() as RunStatus;
const toDbKind = (kind: RunKind): DbRunKind => kind.toUpperCase() as DbRunKind;
const fromDbKind = (kind: DbRunKind): RunKind => kind.toLowerCase() as RunKind;
const toDbSummary = (status: SummaryStatus): DbSummaryStatus =>
  status.toUpperCase() as DbSummaryStatus;
const fromDbSummary = (status: DbSummaryStatus): SummaryStatus =>
  status.toLowerCase() as SummaryStatus;
const toDbRole = (role: TurnRole): DbTurnRole => role.toUpperCase() as DbTurnRole;
const fromDbRole = (role: DbTurnRole): TurnRole => role.toLowerCase() as TurnRole;

/**
 * Stored parts back into `AgentMessagePart[]`. The column is written only by
 * this engine, but it is JSON: anything that is not an array of `{ type }`
 * objects is dropped rather than trusted.
 */
export function partsFromJson(value: unknown): AgentMessagePart[] {
  if (!Array.isArray(value)) return [];
  const parts: AgentMessagePart[] = [];
  for (const item of value) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const record: Record<string, unknown> = { ...item };
      if (typeof record.type === "string") parts.push({ ...record, type: record.type });
    }
  }
  return parts;
}

/** Parts as a JSON column value (a structured-clone-safe copy). */
function partsToJson(parts: AgentMessagePart[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(parts)) as Prisma.InputJsonValue;
}

const packageSelect = {
  id: true,
  ownerId: true,
  identifier: true,
  ecosystem: true,
  name: true,
  gitUrl: true,
  sshKeyId: true,
  isSnapshot: true,
  repositoryId: true,
  tagPattern: true,
  defaultRef: true,
  subdirectory: true,
  notes: true,
} satisfies Prisma.PackageSelect;

const conversationSelect = {
  id: true,
  ownerId: true,
  packageId: true,
  packageIdentifier: true,
  requestedVersion: true,
  requestedRef: true,
  checkoutId: true,
  commitSha: true,
  resolvedFrom: true,
} satisfies Prisma.ConversationSelect;

const checkoutSelect = {
  id: true,
  repositoryId: true,
  sha: true,
  status: true,
  repoMap: true,
  summary: true,
  summaryStatus: true,
} satisfies Prisma.CheckoutSelect;

const runSelect = {
  id: true,
  conversationId: true,
  kind: true,
  status: true,
  stopReason: true,
  error: true,
  answer: true,
  iterations: true,
  inputTokens: true,
  outputTokens: true,
  cachedInputTokens: true,
  costUsdMicros: true,
} satisfies Prisma.AgentRunSelect;

type CheckoutRow = Prisma.CheckoutGetPayload<{ select: typeof checkoutSelect }>;

function checkoutStatusFromDb(status: CheckoutRow["status"]): CheckoutForRun["status"] {
  return status === "READY" ? "ready" : status === "FAILED" ? "failed" : "pending";
}

function checkoutFromRow(row: CheckoutRow): CheckoutForRun {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    sha: row.sha,
    status: checkoutStatusFromDb(row.status),
    repoMap: row.repoMap,
    summary: row.summary,
    summaryStatus: fromDbSummary(row.summaryStatus),
  };
}

/** Longest history read for a follow-up; far above any real conversation. */
export const MAX_HISTORY_TURNS = 5_000;

const ACTIVE: DbRunStatus[] = ["QUEUED", "RUNNING"];

/** Bound on the `checkout.summarize` jobs read at boot; far above any real backlog. */
export const MAX_SUMMARY_JOBS_SCANNED = 10_000;

/** A `checkout.summarize` payload's checkout id, or null when it is not one. */
function payloadCheckoutId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("checkoutId" in payload)) return null;
  return typeof payload.checkoutId === "string" ? payload.checkoutId : null;
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2003";
}

export const prismaRunStore: RunStore = {
  async loadPackage(ownerId, packageId) {
    return prisma.package.findFirst({ where: { id: packageId, ownerId }, select: packageSelect });
  },

  async createConversation(data) {
    return prisma.conversation.create({
      data: {
        ownerId: data.ownerId,
        packageId: data.packageId,
        packageIdentifier: data.packageIdentifier,
        requestedVersion: data.requestedVersion,
        requestedRef: data.requestedRef,
        checkoutId: data.checkoutId,
        commitSha: data.commitSha,
        resolvedFrom: data.resolvedFrom,
        origin: data.origin === "mcp" ? "MCP" : "WEB",
        mcpAgentTokenId: data.mcpAgentTokenId,
        mcpGrantId: data.mcpGrantId,
        mcpConnectionLabel: data.mcpConnectionLabel,
        title: data.title,
      },
      select: conversationSelect,
    });
  },

  async loadConversation(ownerId, conversationId) {
    return prisma.conversation.findFirst({
      where: { id: conversationId, ownerId },
      select: conversationSelect,
    });
  },

  async latestMainRun(conversationId) {
    const row = await prisma.agentRun.findFirst({
      where: { conversationId, kind: "MAIN" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true },
    });
    return row ? { id: row.id, status: fromDbStatus(row.status) } : null;
  },

  async updateConversation(conversationId, data) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data,
      select: { id: true },
    });
  },

  async createRun(data) {
    return prisma.agentRun.create({
      data: {
        ownerId: data.ownerId,
        conversationId: data.conversationId,
        parentRunId: data.parentRunId,
        checkoutId: data.checkoutId,
        kind: toDbKind(data.kind),
        trigger:
          data.trigger === "mcp_query"
            ? "MCP_QUERY"
            : data.trigger === "web_message"
              ? "WEB_MESSAGE"
              : "SUMMARY",
        status: toDbStatus(data.status),
        model: data.model,
        focus: data.focus,
        startedAt: data.startedAt,
      },
      select: { id: true },
    });
  },

  async updateRun(runId, data) {
    const { status, ...rest } = data;
    await prisma.agentRun.update({
      where: { id: runId },
      data: { ...rest, ...(status ? { status: toDbStatus(status) } : {}) },
      select: { id: true },
    });
  },

  async finishRunIfActive(runId, data) {
    const { status, ...rest } = data;
    const { count } = await prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ACTIVE } },
      data: { ...rest, ...(status ? { status: toDbStatus(status) } : {}) },
    });
    return count > 0;
  },

  async closeActiveHelpers(parentRunId, data, excludeIds = []) {
    const { count } = await prisma.agentRun.updateMany({
      where: {
        parentRunId,
        kind: "HELPER",
        status: { in: ACTIVE },
        ...(excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : {}),
      },
      data: {
        status: toDbStatus(data.status),
        stopReason: data.stopReason,
        error: data.error,
        finishedAt: data.finishedAt,
      },
    });
    return count;
  },

  async getRun(ownerId, runId) {
    const row = await prisma.agentRun.findFirst({
      where: { id: runId, ownerId },
      select: runSelect,
    });
    if (!row) return null;
    return { ...row, kind: fromDbKind(row.kind), status: fromDbStatus(row.status) };
  },

  async insertTurn(turn) {
    await prisma.runTurn.create({
      data: {
        runId: turn.runId,
        seq: turn.seq,
        role: toDbRole(turn.role),
        parts: partsToJson(turn.parts),
        steering: turn.steering,
      },
      select: { id: true },
    });
  },

  async listHistoryTurns(conversationId) {
    // Newest first so the cap drops the oldest turns, then back to oldest first.
    const rows = await prisma.runTurn.findMany({
      where: { AgentRun: { conversationId, kind: "MAIN", status: { notIn: ACTIVE } } },
      orderBy: [{ AgentRun: { createdAt: "desc" } }, { runId: "desc" }, { seq: "desc" }],
      select: { id: true, runId: true, seq: true, role: true, parts: true, steering: true },
      take: MAX_HISTORY_TURNS,
    });
    return rows.reverse().map((row) => ({
      id: row.id,
      runId: row.runId,
      seq: row.seq,
      role: fromDbRole(row.role),
      parts: partsFromJson(row.parts),
      steering: row.steering,
    }));
  },

  async upsertCheckout(repositoryId, sha, resolvedFrom) {
    const row = await prisma.checkout.upsert({
      where: { repositoryId_sha: { repositoryId, sha } },
      create: { repositoryId, sha, resolvedFrom },
      update: resolvedFrom ? { resolvedFrom } : {},
      select: { id: true },
    });
    return row.id;
  },

  async loadCheckout(checkoutId) {
    const row = await prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: checkoutSelect,
    });
    return row ? checkoutFromRow(row) : null;
  },

  async loadCheckoutStatus(checkoutId) {
    const row = await prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: { status: true },
    });
    return row ? checkoutStatusFromDb(row.status) : null;
  },

  async loadSummaryTarget(checkoutId) {
    const row = await prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: { ...checkoutSelect, Repository: { select: { remoteKey: true } } },
    });
    if (!row) return null;
    const { Repository, ...checkout } = row;
    return { ...checkoutFromRow(checkout), remoteKey: Repository.remoteKey };
  },

  async ownsCheckout(ownerId, checkoutId, packageId) {
    const row = await prisma.checkout.findFirst({
      where: {
        id: checkoutId,
        Repository: { Packages: { some: { ownerId, ...(packageId ? { id: packageId } : {}) } } },
      },
      select: { id: true },
    });
    return row !== null;
  },

  async ownerMayRun(ownerId) {
    const row = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { banned: true, banExpires: true } satisfies Prisma.UserSelect,
    });
    if (!row) return false;
    if (row.banned !== true) return true;
    return row.banExpires !== null && row.banExpires.getTime() <= Date.now();
  },

  async loadSummaryOverride(checkoutId, ownerId) {
    const row = await prisma.checkoutSummaryOverride.findUnique({
      where: { checkoutId_userId: { checkoutId, userId: ownerId } },
      select: { body: true },
    });
    return row?.body ?? null;
  },

  async saveRepoMap(checkoutId, repoMap) {
    await prisma.checkout.updateMany({ where: { id: checkoutId }, data: { repoMap } });
  },

  async acquireLease(runId, checkoutId, expiresAt) {
    // Renewing a lease that is still live needs no gate: checkout and
    // repository deletion refuse while any unexpired lease exists, so they
    // cannot be mid-delete. Skipping the repository lock here keeps a renewal
    // (and the run's slot release that awaits it) from queueing behind a long
    // fetch that holds the same lock.
    const renewed = await prisma.checkoutLease.updateMany({
      where: { runId, checkoutId, expiresAt: { gt: new Date() } },
      data: { expiresAt },
    });
    if (renewed.count > 0) return true;
    const checkout = await prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: { repositoryId: true },
    });
    if (!checkout) return false;
    return withRepositoryLock(checkout.repositoryId, async () => {
      try {
        await prisma.checkoutLease.upsert({
          where: { runId_checkoutId: { runId, checkoutId } },
          create: { runId, checkoutId, expiresAt },
          update: { expiresAt },
          select: { id: true },
        });
        return true;
      } catch (error) {
        // Deletion won the gate: let the existing caller retry materialization.
        if (isForeignKeyViolation(error)) return false;
        throw error;
      }
    });
  },

  async releaseLeases(runId) {
    await prisma.checkoutLease.deleteMany({ where: { runId } });
  },

  async interruptOrphanRuns(finishedAt, liveRunIds) {
    const orphan = { status: { in: ACTIVE }, id: { notIn: liveRunIds } };
    // Sequential: the summary reset must see the SUMMARY runs still active.
    const [, , interrupted] = await prisma.$transaction([
      prisma.checkout.updateMany({
        where: { summaryStatus: "PENDING", AgentRuns: { some: { kind: "SUMMARY", ...orphan } } },
        data: { summaryStatus: "NONE" },
      }),
      prisma.checkoutLease.deleteMany({ where: { runId: { notIn: liveRunIds } } }),
      prisma.agentRun.updateMany({
        where: orphan,
        data: {
          status: "INTERRUPTED",
          stopReason: "interrupted",
          error: "The server restarted while this run was in progress.",
          finishedAt,
        },
      }),
    ]);
    return interrupted.count;
  },

  async resetOrphanSummaries() {
    // Jobs that will still run: queued, or running with an attempt left (a
    // dead process's running row is requeued by stale recovery). One with no
    // attempt left is failed by that recovery without running the handler.
    const jobs = await prisma.backgroundJob.findMany({
      where: {
        type: summarizeCheckoutJob.type,
        OR: [
          { status: "queued" },
          { status: "running", attempts: { lt: prisma.backgroundJob.fields.maxAttempts } },
        ],
      },
      select: { payload: true },
      take: MAX_SUMMARY_JOBS_SCANNED,
    });
    // Truncated: some PENDING summaries may have a job not seen here. Reset
    // nothing rather than orphan a job's work; the next boot looks again.
    if (jobs.length >= MAX_SUMMARY_JOBS_SCANNED) return 0;
    const covered = jobs.flatMap((job) => {
      const checkoutId = payloadCheckoutId(job.payload);
      return checkoutId ? [checkoutId] : [];
    });
    const { count } = await prisma.checkout.updateMany({
      where: {
        summaryStatus: "PENDING",
        id: { notIn: covered },
        AgentRuns: { none: { kind: "SUMMARY", status: { in: ACTIVE } } },
      },
      data: { summaryStatus: "NONE" },
    });
    return count;
  },

  async markSummaryPending(checkoutId, from) {
    // Only the generated summary's status moves; its previous text stays
    // readable while the new one is written. Overrides live in their own table.
    const { count } = await prisma.checkout.updateMany({
      where: { id: checkoutId, summaryStatus: { in: from.map(toDbSummary) } },
      data: { summaryStatus: "PENDING" },
    });
    return count > 0;
  },

  async finishSummary(checkoutId, data) {
    const { count } = await prisma.checkout.updateMany({
      where: { id: checkoutId, summaryStatus: "PENDING" },
      data:
        data.status === "ready"
          ? {
              summaryStatus: "READY",
              summary: data.summary,
              summaryModel: data.model,
              summaryGeneratedAt: data.generatedAt,
            }
          : { summaryStatus: toDbSummary(data.status) },
    });
    return count > 0;
  },
};
