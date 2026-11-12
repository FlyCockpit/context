import { EventEmitter } from "node:events";

/**
 * In-process, typed publish/subscribe. One bus per kind of event (job wakeups,
 * a conversation's live run stream, …), one topic per subject inside it
 * (usually an entity id).
 *
 * Process-local by design: Cockpit Context runs exactly one app replica (docs/hosting.md),
 * so there is no cross-process fan-out. A second replica would not see events
 * published here; that is the documented single-replica constraint, not a bug
 * to paper over with a shared store.
 *
 * Delivery is synchronous and best-effort. A subscriber that throws is logged
 * and skipped; it never prevents the remaining subscribers from receiving the
 * event, and it never surfaces in the publisher. Events published before a
 * subscriber attaches are not replayed: consumers that need history read a
 * snapshot from Postgres first, then subscribe (see `iterate`).
 */
export type EventBus<TEvent> = {
  /** Deliver `event` to every current subscriber of `topic`. Returns the subscriber count. */
  publish(topic: string, event: TEvent): number;
  /** Attach a listener; the returned function detaches it (idempotent). */
  subscribe(topic: string, listener: (event: TEvent) => void): () => void;
  /** Current subscriber count for `topic`. */
  listenerCount(topic: string): number;
  /**
   * Async-iterate a topic's events until `signal` aborts or the consumer
   * breaks out. Buffers at most `maxBuffered` undelivered events; past that the
   * iterator throws `EventBusOverflowError` so a slow consumer resubscribes
   * (with a fresh snapshot) instead of growing memory without bound.
   */
  iterate(
    topic: string,
    options?: { signal?: AbortSignal; maxBuffered?: number },
  ): AsyncIterableIterator<TEvent>;
};

export class EventBusOverflowError extends Error {
  constructor(topic: string, maxBuffered: number) {
    super(`Event bus subscriber on "${topic}" fell more than ${maxBuffered} events behind.`);
    this.name = "EventBusOverflowError";
  }
}

const DEFAULT_MAX_BUFFERED = 1000;

export function createEventBus<TEvent>(options: { name: string }): EventBus<TEvent> {
  const emitter = new EventEmitter();
  // Many browser tabs may watch one conversation; the per-topic subscriber
  // count is bounded by the callers (auth + rate limits), not by Node's
  // default leak warning at 10.
  emitter.setMaxListeners(0);

  function subscribe(topic: string, listener: (event: TEvent) => void): () => void {
    const safe = (event: TEvent) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`[event-bus:${options.name}] subscriber on "${topic}" threw:`, error);
      }
    };
    emitter.on(topic, safe);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      emitter.off(topic, safe);
    };
  }

  function iterate(
    topic: string,
    iterateOptions: { signal?: AbortSignal; maxBuffered?: number } = {},
  ): AsyncIterableIterator<TEvent> {
    const maxBuffered = iterateOptions.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    const { signal } = iterateOptions;
    const buffer: TEvent[] = [];
    // At most one `next()` waits at a time; it takes the next event directly,
    // so the buffer only fills while no consumer is waiting.
    let pending: ((result: IteratorResult<TEvent>) => void) | undefined;
    let failure: unknown;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      signal?.removeEventListener("abort", finish);
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ value: undefined, done: true });
      }
    };

    const unsubscribe = subscribe(topic, (event) => {
      if (done) return;
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ value: event, done: false });
        return;
      }
      if (buffer.length >= maxBuffered) {
        failure = new EventBusOverflowError(topic, maxBuffered);
        buffer.length = 0;
        finish();
        return;
      }
      buffer.push(event);
    });

    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });

    const iterator: AsyncIterableIterator<TEvent> = {
      next() {
        const queued = buffer.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (failure !== undefined) {
          const error = failure;
          failure = undefined;
          return Promise.reject(error);
        }
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<TEvent>>((resolve) => {
          pending = resolve;
        });
      },
      return() {
        buffer.length = 0;
        failure = undefined;
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };

    return iterator;
  }

  return {
    publish(topic, event) {
      const count = emitter.listenerCount(topic);
      if (count > 0) emitter.emit(topic, event);
      return count;
    },
    subscribe,
    listenerCount: (topic) => emitter.listenerCount(topic),
    iterate,
  };
}
