/**
 * Latest-value throttle for live deltas: at most one emit per `intervalMs`,
 * always emitting the newest value (leading and trailing edge). Timers are
 * `unref()`'d so a pending delta never holds the process open.
 */
export class LatestThrottle<T> {
  private pending: { value: T } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEmit = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (value: T) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(value: T): void {
    this.pending = { value };
    if (this.timer) return;
    const wait = this.lastEmit + this.intervalMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  /** Emit the pending value now, if any. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.lastEmit = this.now();
    this.emit(pending.value);
  }

  /** Drop the pending value (the message it described has finished). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
