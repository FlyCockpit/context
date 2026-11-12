import type { RunStatus } from "../events";
import type {
  CheckoutForRun,
  ConversationForRun,
  NewConversation,
  NewRun,
  NewTurn,
  PackageForRun,
  RunRecord,
  RunStore,
  RunUpdate,
  StoredTurn,
  SummaryStatus,
} from "../store";

/**
 * Test-only in-memory {@link RunStore}: the engine's whole persistence
 * boundary as plain maps, so engine tests can assert what was saved (and in
 * which order) without a database.
 */

export type MemoryRun = NewRun &
  Required<Omit<RunUpdate, "checkoutId" | "startedAt" | "finishedAt">> & {
    id: string;
    createdAt: number;
    startedAt: Date | null;
    finishedAt: Date | null;
  };

export type MemoryCheckout = CheckoutForRun & { remoteKey: string; summaryModel?: string };

export class MemoryRunStore implements RunStore {
  readonly packages = new Map<string, PackageForRun>();
  /** packageId → repositoryId (`Package.repositoryId`). */
  readonly packageRepositories = new Map<string, string>();
  readonly conversations = new Map<string, ConversationForRun & { lastActivityAt?: Date }>();
  readonly runs = new Map<string, MemoryRun>();
  readonly turns: Array<NewTurn & { id: string }> = [];
  readonly checkouts = new Map<string, MemoryCheckout>();
  /** `${checkoutId}:${userId}` → that user's own edited overview. */
  readonly summaryOverrides = new Map<string, string>();
  /** runId → checkoutId → expiresAt */
  readonly leases = new Map<string, Map<string, Date>>();
  /** Every lease ever taken, for "was it held" assertions. */
  readonly leaseLog: Array<{ runId: string; checkoutId: string }> = [];
  /** Checkouts with a `checkout.summarize` job that will still run (queued, or retryable). */
  readonly summaryJobs = new Set<string>();
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  async loadPackage(ownerId: string, packageId: string) {
    const pkg = this.packages.get(packageId);
    return pkg && pkg.ownerId === ownerId ? { ...pkg } : null;
  }

  async createConversation(data: NewConversation) {
    const row: ConversationForRun = {
      id: this.nextId("conv"),
      ownerId: data.ownerId,
      packageId: data.packageId,
      packageIdentifier: data.packageIdentifier,
      requestedVersion: data.requestedVersion,
      requestedRef: data.requestedRef,
      checkoutId: data.checkoutId,
      commitSha: data.commitSha,
      resolvedFrom: data.resolvedFrom,
    };
    this.conversations.set(row.id, { ...row });
    return { ...row };
  }

  async loadConversation(ownerId: string, conversationId: string) {
    const row = this.conversations.get(conversationId);
    return row && row.ownerId === ownerId ? { ...row } : null;
  }

  async latestMainRun(conversationId: string) {
    const mains = [...this.runs.values()]
      .filter((run) => run.conversationId === conversationId && run.kind === "main")
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = mains[0];
    return latest ? { id: latest.id, status: latest.status } : null;
  }

  async updateConversation(
    conversationId: string,
    data: { checkoutId?: string; lastActivityAt?: Date },
  ) {
    const row = this.conversations.get(conversationId);
    if (row) Object.assign(row, data);
  }

  async createRun(data: NewRun) {
    const id = this.nextId(`${data.kind}-run`);
    this.runs.set(id, {
      ...data,
      id,
      createdAt: this.counter,
      stopReason: null,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsdMicros: 0,
      iterations: 0,
      finishedAt: null,
      answer: null,
    });
    return { id };
  }

  async updateRun(runId: string, data: RunUpdate) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    Object.assign(run, data);
  }

  async finishRunIfActive(runId: string, data: RunUpdate) {
    const run = this.runs.get(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    Object.assign(run, data);
    return true;
  }

  async closeActiveHelpers(
    parentRunId: string,
    data: { status: RunStatus; stopReason: string | null; error: string | null; finishedAt: Date },
    excludeIds: readonly string[] = [],
  ) {
    let count = 0;
    for (const run of this.runs.values()) {
      if (
        run.parentRunId === parentRunId &&
        !excludeIds.includes(run.id) &&
        run.kind === "helper" &&
        (run.status === "queued" || run.status === "running")
      ) {
        Object.assign(run, data);
        count += 1;
      }
    }
    return count;
  }

  async getRun(ownerId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== ownerId) return null;
    return {
      id: run.id,
      conversationId: run.conversationId,
      kind: run.kind,
      status: run.status,
      stopReason: run.stopReason,
      error: run.error,
      answer: run.answer,
      iterations: run.iterations,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      costUsdMicros: run.costUsdMicros,
    };
  }

  async insertTurn(turn: NewTurn) {
    if (this.turns.some((row) => row.runId === turn.runId && row.seq === turn.seq)) {
      throw new Error(`duplicate turn ${turn.runId}/${turn.seq}`);
    }
    this.turns.push({ ...turn, id: this.nextId("turn") });
  }

  turnsOf(runId: string) {
    return this.turns.filter((turn) => turn.runId === runId).sort((a, b) => a.seq - b.seq);
  }

  async listHistoryTurns(conversationId: string): Promise<StoredTurn[]> {
    const runs = [...this.runs.values()]
      .filter(
        (run) =>
          run.conversationId === conversationId &&
          run.kind === "main" &&
          run.status !== "queued" &&
          run.status !== "running",
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    return runs.flatMap((run) =>
      this.turnsOf(run.id).map((turn) => ({
        id: turn.id,
        runId: turn.runId,
        seq: turn.seq,
        role: turn.role,
        parts: turn.parts,
        steering: turn.steering,
      })),
    );
  }

  async upsertCheckout(repositoryId: string, sha: string, _resolvedFrom?: string | null) {
    const existing = [...this.checkouts.values()].find(
      (row) => row.repositoryId === repositoryId && row.sha === sha,
    );
    if (existing) return existing.id;
    const id = this.nextId("chk");
    this.checkouts.set(id, {
      id,
      repositoryId,
      sha,
      status: "pending",
      repoMap: null,
      summary: null,
      summaryStatus: "none",
      remoteKey: `https://example.com/${repositoryId}`,
    });
    return id;
  }

  async loadCheckout(checkoutId: string) {
    const row = this.checkouts.get(checkoutId);
    if (!row) return null;
    const { remoteKey: _remoteKey, summaryModel: _model, ...checkout } = row;
    return { ...checkout };
  }

  async loadCheckoutStatus(checkoutId: string) {
    return this.checkouts.get(checkoutId)?.status ?? null;
  }

  async loadSummaryTarget(checkoutId: string) {
    const row = this.checkouts.get(checkoutId);
    return row ? { ...row } : null;
  }

  async ownsCheckout(ownerId: string, checkoutId: string, packageId?: string) {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) return false;
    return [...this.packages.values()].some(
      (pkg) =>
        pkg.ownerId === ownerId &&
        (!packageId || pkg.id === packageId) &&
        this.packageRepositories.get(pkg.id) === checkout.repositoryId,
    );
  }

  /** Owners that may not run (archived or deleted accounts). */
  readonly inactiveOwners = new Set<string>();

  async ownerMayRun(ownerId: string) {
    return !this.inactiveOwners.has(ownerId);
  }

  async loadSummaryOverride(checkoutId: string, ownerId: string) {
    return this.summaryOverrides.get(`${checkoutId}:${ownerId}`) ?? null;
  }

  async saveRepoMap(checkoutId: string, repoMap: unknown) {
    const row = this.checkouts.get(checkoutId);
    if (row) row.repoMap = repoMap;
  }

  async acquireLease(runId: string, checkoutId: string, expiresAt: Date) {
    if (!this.checkouts.has(checkoutId)) return false;
    const byCheckout = this.leases.get(runId) ?? new Map<string, Date>();
    byCheckout.set(checkoutId, expiresAt);
    this.leases.set(runId, byCheckout);
    this.leaseLog.push({ runId, checkoutId });
    return true;
  }

  async releaseLeases(runId: string) {
    this.leases.delete(runId);
  }

  heldLeases(): Array<{ runId: string; checkoutId: string }> {
    return [...this.leases].flatMap(([runId, byCheckout]) =>
      [...byCheckout.keys()].map((checkoutId) => ({ runId, checkoutId })),
    );
  }

  async interruptOrphanRuns(finishedAt: Date, liveRunIds: string[]) {
    const live = new Set(liveRunIds);
    for (const runId of [...this.leases.keys()]) {
      if (!live.has(runId)) this.leases.delete(runId);
    }
    const active: RunStatus[] = ["queued", "running"];
    const orphaned = (run: MemoryRun) => active.includes(run.status) && !live.has(run.id);
    for (const run of this.runs.values()) {
      const checkout = run.checkoutId ? this.checkouts.get(run.checkoutId) : undefined;
      if (run.kind === "summary" && orphaned(run) && checkout?.summaryStatus === "pending") {
        checkout.summaryStatus = "none";
      }
    }
    let count = 0;
    for (const run of this.runs.values()) {
      if (orphaned(run)) {
        run.status = "interrupted";
        run.finishedAt = finishedAt;
        count += 1;
      }
    }
    return count;
  }

  async resetOrphanSummaries() {
    let count = 0;
    for (const checkout of this.checkouts.values()) {
      if (checkout.summaryStatus !== "pending" || this.summaryJobs.has(checkout.id)) continue;
      const active = [...this.runs.values()].some(
        (run) =>
          run.kind === "summary" &&
          run.checkoutId === checkout.id &&
          (run.status === "queued" || run.status === "running"),
      );
      if (active) continue;
      checkout.summaryStatus = "none";
      count += 1;
    }
    return count;
  }

  async markSummaryPending(checkoutId: string, from: SummaryStatus[]) {
    const row = this.checkouts.get(checkoutId);
    if (!row || !from.includes(row.summaryStatus)) return false;
    row.summaryStatus = "pending";
    return true;
  }

  async finishSummary(
    checkoutId: string,
    data:
      | { status: "ready"; summary: string; model: string; generatedAt: Date }
      | { status: "failed" | "none" },
  ) {
    const row = this.checkouts.get(checkoutId);
    if (row?.summaryStatus !== "pending") return false;
    row.summaryStatus = data.status;
    if (data.status === "ready") {
      row.summary = data.summary;
      row.summaryModel = data.model;
    }
    return true;
  }
}
