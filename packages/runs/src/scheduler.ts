/**
 * Run concurrency: a global cap and a per-user cap
 * (COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS / COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER). Waiters are
 * served in arrival order; a waiter whose user is at their cap is passed
 * over (it keeps its place) so one busy user never blocks everyone else.
 *
 * A waiter acquired with `perUser: false` (summary runs) counts toward the
 * global cap only: it neither
 * waits on nor takes one of its user's per-user slots.
 */
export interface SchedulerLimits {
  global: number;
  perUser: number;
}

export interface AcquireOptions {
  /** Count this slot toward its user's per-user cap (default true). */
  perUser?: boolean;
}

type Waiter = {
  ownerId: string;
  perUser: boolean;
  grant: (release: () => void) => void;
  fail: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class RunScheduler {
  private active = 0;
  private readonly activeByUser = new Map<string, number>();
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limits: SchedulerLimits) {}

  /**
   * Resolve with a release function once a slot is free. Rejects with the
   * signal's reason if it aborts first (the waiter leaves the queue).
   */
  acquire(ownerId: string, signal?: AbortSignal, options?: AcquireOptions): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        ownerId,
        perUser: options?.perUser ?? true,
        grant: resolve,
        fail: reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** Runs holding a slot, and runs waiting for one. */
  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  private pump(): void {
    for (let index = 0; index < this.waiting.length && this.active < this.limits.global; ) {
      const waiter = this.waiting[index];
      if (!waiter) break;
      const userActive = this.activeByUser.get(waiter.ownerId) ?? 0;
      if (waiter.perUser && userActive >= this.limits.perUser) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      if (waiter.perUser) this.activeByUser.set(waiter.ownerId, userActive + 1);
      waiter.grant(this.releaser(waiter));
    }
  }

  private releaser(waiter: Waiter): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (waiter.perUser) {
        const left = (this.activeByUser.get(waiter.ownerId) ?? 1) - 1;
        if (left <= 0) this.activeByUser.delete(waiter.ownerId);
        else this.activeByUser.set(waiter.ownerId, left);
      }
      this.pump();
    };
  }
}
