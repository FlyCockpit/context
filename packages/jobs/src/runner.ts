import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { backoffDelayMs, PermanentJobError, type RegisteredJob } from "./define";
import {
  type ClaimedJob,
  claimJobs,
  markFailed,
  markRetry,
  markSucceeded,
  recoverStaleJobs,
  refreshLocks,
  releaseClaim,
} from "./store";
import { jobWakeups } from "./wakeups";

export type JobRunnerHealth = "stopped" | "running" | "failing";

/** Reported once per job that will not be retried (out of attempts, or a permanent error). */
export type TerminalFailure = {
  id: string;
  type: string;
  attempts: number;
  error: string;
};

export type JobRunnerOptions = {
  jobs: readonly RegisteredJob[];
  /** Jobs executed at once across all types. Default 2. */
  concurrency?: number;
  /** Fallback poll when no wakeup arrives. Default 5 s. */
  pollIntervalMs?: number;
  /**
   * A `running` row whose lock has not been refreshed for this long is
   * recovered as stale — on boot and periodically. In-flight locks refresh
   * every third of it, so a live runner's rows never qualify, even during a
   * deploy that briefly overlaps the old and new process. Default 2 min.
   */
  staleLockMs?: number;
  /** How long `stop()` waits for in-flight jobs before aborting them. Default 15 s. */
  drainTimeoutMs?: number;
  /** Lock owner id. Default `<hostname>:<pid>:<uuid>`. */
  workerId?: string;
  onTerminalFailure?: (failure: TerminalFailure) => void | Promise<void>;
  /** Injected clock for tests. */
  now?: () => number;
};

export type JobRunner = {
  /**
   * Recover orphaned rows, then start polling. Rejects if recovery fails. A
   * `stop()` while recovery is in flight wins: `start()` then resolves without
   * polling, and the runner stays stopped.
   */
  start(): Promise<void>;
  /**
   * Stop claiming, wait up to `drainTimeoutMs` for in-flight jobs, then abort
   * the rest (their rows stay `running` and are recovered on the next boot).
   * Terminal-failure reports already in flight are awaited within the same
   * deadline. Claims in flight must settle and return unstarted work under
   * their ownership tokens. Resolves `true` only after admission settles and
   * every admitted job finishes inside the deadline.
   * Idempotent.
   */
  stop(): Promise<boolean>;
  /** Claim immediately instead of waiting for the next poll. */
  wake(): void;
  health(): JobRunnerHealth;
  /** Ids currently executing in this process. */
  activeJobIds(): string[];
  readonly workerId: string;
};

/**
 * The in-process job runner. One per process (the server creates it in
 * `apps/server/src/jobs/index.ts`); Cockpit Context runs a single app replica, but the
 * claim uses `SKIP LOCKED` and each attempt has a fresh ownership token.
 * Handlers remain at-least-once across expired locks and process crashes.
 *
 * Every timer is `unref()`'d: an idle runner never keeps the process alive.
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const concurrency = options.concurrency ?? 2;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const staleLockMs = options.staleLockMs ?? 2 * 60_000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Job runner concurrency must be an integer >= 1 (got ${concurrency}).`);
  }

  const registry = new Map<string, RegisteredJob>();
  for (const job of options.jobs) {
    if (registry.has(job.definition.type)) {
      throw new Error(`Job type "${job.definition.type}" is registered twice.`);
    }
    registry.set(job.definition.type, job);
  }
  const types = [...registry.keys()];

  const active = new Map<
    string,
    { done: Promise<void>; abort: AbortController; claimToken: string }
  >();
  let state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";
  /** The boot recovery while `start()` awaits it; `stop()` waits for it too. */
  let startingRecovery: Promise<unknown> | undefined;
  let failing = false;
  let admissionReleaseFailed = false;
  let ticking = false;
  let tickAgain = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let lockTimer: ReturnType<typeof setInterval> | undefined;
  let lastStaleSweep = 0;
  let unsubscribe: (() => void) | undefined;
  let stopping: Promise<boolean> | undefined;
  /** The claim loop in flight, if any: its stale sweep may still start reports. */
  let tickRun: Promise<void> | undefined;
  /** Terminal-failure reports of stale sweeps (cooldown rows, SMTP) in flight. */
  const reports = new Set<Promise<void>>();

  function schedulePoll(delayMs: number) {
    if (state !== "running") return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void tick(), delayMs);
    pollTimer.unref();
  }

  function tick(): Promise<void> {
    if (state !== "running") return Promise.resolve();
    // Serialize claims: a wakeup during a claim re-runs the loop once after it
    // instead of racing a second claim for the same free slots.
    if (ticking) {
      tickAgain = true;
      return tickRun ?? Promise.resolve();
    }
    tickRun = claimLoop();
    return tickRun;
  }

  async function claimLoop(): Promise<void> {
    ticking = true;
    try {
      do {
        tickAgain = false;
        if (now() - lastStaleSweep >= staleLockMs) {
          lastStaleSweep = now();
          handleRecovery(await recoverStaleJobs(new Date(now() - staleLockMs), [...active.keys()]));
        }
        const free = concurrency - active.size;
        if (free <= 0 || state !== "running") break;
        const claimed = await claimJobs(workerId, types, free, [...active.keys()]);
        failing = false;
        if (state !== "running") {
          const released = await Promise.allSettled(claimed.map((job) => releaseClaim(job)));
          admissionReleaseFailed = released.some((result) => result.status === "rejected");
          if (admissionReleaseFailed) {
            console.error(
              "[jobs] Could not return unstarted claims; stale recovery will retry them.",
            );
          }
        } else {
          for (const job of claimed) execute(job);
        }
        // A full claim means more may be waiting: go again right away.
        if (claimed.length === free) tickAgain = true;
      } while (tickAgain && state === "running" && active.size < concurrency);
    } catch (error) {
      if (!failing) console.error("[jobs] Claim loop failed:", describeError(error));
      failing = true;
    } finally {
      ticking = false;
      schedulePoll(pollIntervalMs);
    }
  }

  function execute(job: ClaimedJob) {
    const abort = new AbortController();
    const done = run(job, abort.signal).finally(() => {
      if (active.get(job.id)?.claimToken === job.claimToken) active.delete(job.id);
      // A slot freed up; look for more work without waiting for the poll.
      if (state === "running") void tick();
    });
    active.set(job.id, { done, abort, claimToken: job.claimToken });
  }

  async function run(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    const registered = registry.get(job.type);
    const started = now();
    try {
      if (!registered) throw new PermanentJobError(`No handler registered for "${job.type}".`);
      const parsed = registered.definition.payload.safeParse(job.payload);
      if (!parsed.success) {
        throw new PermanentJobError(`Invalid payload: ${parsed.error.message}`);
      }
      await registered.handler({
        id: job.id,
        type: job.type,
        payload: parsed.data,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        signal,
      });
    } catch (error) {
      await recordFailure(job, registered, error).catch((recordError: unknown) => {
        // The row stays `running`; stale recovery requeues it later.
        console.error(
          `[jobs] Could not record the failure of ${job.type} ${job.id}:`,
          describeError(recordError),
        );
      });
      return;
    }
    // Outside the handler's try: the job did succeed, so a failed write here
    // must never be recorded as a job failure (a needless retry, or a false
    // terminal-failure alert).
    await recordSuccess(job, started);
  }

  async function recordSuccess(job: ClaimedJob, started: number): Promise<void> {
    let recorded: boolean;
    try {
      recorded = await markSucceeded(job.id, job.claimToken);
    } catch {
      try {
        // One immediate retry covers a dropped connection or a pool hiccup.
        recorded = await markSucceeded(job.id, job.claimToken);
      } catch (writeError) {
        // The row stays `running`; stale recovery requeues it later, so the
        // handler may run once more (jobs are at-least-once).
        console.error(
          `[jobs] ${job.type} ${job.id} succeeded but could not be marked succeeded; stale recovery will pick it up:`,
          describeError(writeError),
        );
        return;
      }
    }
    if (!recorded) {
      console.warn(`[jobs] ${job.type} ${job.id} finished but its lock was taken over.`);
    }
    console.log(`[jobs] ${job.type} ${job.id} succeeded in ${now() - started}ms`);
  }

  async function recordFailure(
    job: ClaimedJob,
    registered: RegisteredJob | undefined,
    error: unknown,
  ): Promise<void> {
    const message = describeError(error);
    const permanent = error instanceof PermanentJobError;
    if (!permanent && registered && job.attempts < job.maxAttempts) {
      const delay = backoffDelayMs(registered.definition.backoff, job.attempts);
      await markRetry(job.id, job.claimToken, message, new Date(now() + delay));
      console.warn(
        `[jobs] ${job.type} ${job.id} attempt ${job.attempts}/${job.maxAttempts} failed; retrying in ${delay}ms: ${message}`,
      );
      return;
    }
    const recorded = await markFailed(job.id, job.claimToken, message);
    console.error(
      `[jobs] ${job.type} ${job.id} failed permanently after ${job.attempts} attempt(s): ${message}`,
    );
    if (recorded) {
      await reportTerminalFailure({
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        error: message,
      });
    }
  }

  /** Runs the hook; never throws. */
  async function reportTerminalFailure(failure: TerminalFailure): Promise<void> {
    if (!options.onTerminalFailure) return;
    try {
      await options.onTerminalFailure(failure);
    } catch (hookError) {
      console.error("[jobs] onTerminalFailure hook threw:", describeError(hookError));
    }
  }

  /**
   * Log a stale sweep and report every row it failed (out of attempts after a
   * crash or a drain timeout) as a terminal failure. The reports run in the
   * background, one after another, so alert delivery never holds up claiming;
   * they are tracked in `reports` so `stop()` waits for them (bounded).
   */
  function handleRecovery(recovered: Awaited<ReturnType<typeof recoverStaleJobs>>): void {
    logRecovery(recovered);
    if (recovered.failedJobs.length === 0 || !options.onTerminalFailure) return;
    const report = (async () => {
      for (const row of recovered.failedJobs) {
        await reportTerminalFailure({
          id: row.id,
          type: row.type,
          attempts: row.attempts,
          error: row.lastError ?? "Lock expired.",
        });
      }
    })();
    reports.add(report);
    void report.finally(() => reports.delete(report));
  }

  /** Settles once no report is in flight, including any started while waiting. */
  async function reportsSettled(): Promise<void> {
    while (reports.size > 0) await Promise.allSettled([...reports]);
  }

  return {
    workerId,
    async start() {
      if (state !== "idle") throw new Error("Job runner already started; create a new one.");
      // Claimed before the first await, so a second start() still throws and a
      // stop() during recovery is seen below instead of being overwritten.
      state = "starting";
      // Recover rows orphaned by a crash or a drain timeout. Only locks older
      // than the stale window: recently refreshed locks in an overlapping old
      // process must not be recovered during its drain.
      // Its reports start inside this promise, so a stop() that waits for it
      // always sees them in `reports`.
      const recovery = recoverStaleJobs(new Date(now() - staleLockMs)).then(handleRecovery);
      startingRecovery = recovery;
      try {
        await recovery;
      } catch (error) {
        // Recovery failed before anything started: a later start() may retry,
        // unless stop() already ended this runner.
        if (state === "starting") state = "idle";
        throw error;
      } finally {
        startingRecovery = undefined;
      }
      // stop() ran while recovery was in flight: stay stopped.
      if (state !== "starting") return;
      lastStaleSweep = now();
      state = "running";
      unsubscribe = jobWakeups.subscribe("enqueued", () => void tick());
      lockTimer = setInterval(
        () => {
          const claims = [...active].map(([id, entry]) => ({ id, claimToken: entry.claimToken }));
          refreshLocks(claims)
            .then((lostIds) => {
              for (const id of lostIds) {
                const claim = claims.find((entry) => entry.id === id);
                const entry = active.get(id);
                if (entry && entry.claimToken === claim?.claimToken) entry.abort.abort();
              }
            })
            .catch((error: unknown) => {
              console.error("[jobs] Could not refresh job locks:", describeError(error));
            });
        },
        Math.max(1_000, Math.floor(staleLockMs / 3)),
      );
      lockTimer.unref();
      console.log(
        `[jobs] Runner ${workerId} started (${types.length} type(s), concurrency ${concurrency}).`,
      );
      void tick();
    },
    stop() {
      if (stopping) return stopping;
      const wasRunning = state === "running";
      state = "stopping";
      unsubscribe?.();
      clearTimeout(pollTimer);
      // Stopped mid-start: start() sees the state change once its recovery
      // settles and returns without polling. Wait for that recovery so nothing
      // of this runner is still touching the database when stop() resolves.
      const pendingRecovery = startingRecovery;
      const pendingTick = tickRun;
      stopping = (async () => {
        // One drain deadline bounds every wait below (the boot recovery
        // itself excepted, as before): jobs, the claim loop in flight, and
        // terminal-failure reports, so a hung SMTP send never holds shutdown
        // past `drainTimeoutMs`.
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<false>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(false), drainTimeoutMs);
          deadlineTimer.unref();
        });
        const settledBy = (work: Promise<unknown>) =>
          Promise.race([work.then(() => true as const), deadline]);
        const awaitReports = async () => {
          if (await settledBy(reportsSettled())) return;
          console.warn(
            `[jobs] ${reports.size} terminal-failure report(s) still running after ${drainTimeoutMs}ms; stopping without them.`,
          );
        };
        try {
          if (!wasRunning) {
            await pendingRecovery?.catch(() => {});
            await awaitReports();
            state = "stopped";
            return true;
          }
          // Settle admission first: a claim may have been awaiting the database
          // when stop began. Late rows are returned under their claim tokens.
          let drained =
            (pendingTick ? await settledBy(pendingTick) : true) && !admissionReleaseFailed;
          const inFlight = [...active.values()];
          if (inFlight.length > 0) {
            drained =
              (await settledBy(Promise.allSettled(inFlight.map((entry) => entry.done)))) && drained;
            if (!drained) {
              console.warn(
                `[jobs] ${active.size} job(s) still running after ${drainTimeoutMs}ms; aborting. They are recovered on the next boot.`,
              );
              for (const entry of active.values()) entry.abort.abort();
            }
          }
          await awaitReports();
          clearInterval(lockTimer);
          state = "stopped";
          return drained;
        } finally {
          clearTimeout(deadlineTimer);
        }
      })();
      return stopping;
    },
    wake: () => void tick(),
    health: () => {
      if (state !== "running") return "stopped";
      return failing ? "failing" : "running";
    },
    activeJobIds: () => [...active.keys()],
  };
}

function logRecovery(recovered: { requeued: number; failed: number }) {
  if (recovered.requeued || recovered.failed) {
    console.warn(
      `[jobs] Recovered stale jobs: ${recovered.requeued} requeued, ${recovered.failed} failed (out of attempts).`,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
