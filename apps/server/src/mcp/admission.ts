/**
 * `/mcp` shutdown admission (ported from ws-model-proxy's
 * `mcp/admission.ts`).
 *
 * Every `/mcp` exchange takes a permit at route entry, before its body is
 * read: an owned `AbortController` plus an idempotent `release()`. The route
 * releases only when its handler promise settles. `close()` flips the gate
 * synchronously (later admissions get a 503), aborts every outstanding
 * permit — which cancels a long `query_dependency` wait so it answers
 * `running` instead of holding the HTTP drain — and resolves once every
 * admitted handler has settled.
 */
interface McpAdmission {
  /** Aborted by the client disconnecting and by {@link McpAdmissionGate.close}. */
  readonly controller: AbortController;
  /** Idempotent. Call only once the admitted handler has settled. */
  release(): void;
}

export interface McpAdmissionGate {
  readonly outstanding: number;
  readonly closed: boolean;
  /** A permit, or null once the gate is closed. */
  admit(): McpAdmission | null;
  /** Stop admitting, abort outstanding permits, resolve when all released. */
  close(): Promise<void>;
}

/**
 * A per-key cap on concurrent holders (in-process: one app replica,
 * docs/hosting.md). The admission gate above runs before
 * authentication, so it cannot tell users apart; a tool that holds a
 * request open on a user's behalf takes one of these slots, keyed by the
 * credential's user, once it knows who is asking.
 */
export interface KeyedSlots {
  /** A release (idempotent) for a free slot, or null when `key` holds them all. */
  tryAcquire(key: string): (() => void) | null;
  /** Slots `key` holds now. */
  held(key: string): number;
}

/** `max` is a number, or a reader resolved on every acquire (an env-tunable cap). */
export function createKeyedSlots(max: number | (() => number)): KeyedSlots {
  const counts = new Map<string, number>();
  const limit = typeof max === "function" ? max : () => max;
  return {
    tryAcquire(key) {
      const held = counts.get(key) ?? 0;
      if (held >= limit()) return null;
      counts.set(key, held + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (counts.get(key) ?? 1) - 1;
        if (remaining > 0) counts.set(key, remaining);
        else counts.delete(key);
      };
    },
    held(key) {
      return counts.get(key) ?? 0;
    },
  };
}

export function createMcpAdmissionGate(): McpAdmissionGate {
  let closed = false;
  let outstanding = 0;
  let waiters: Array<() => void> = [];
  const controllers = new Set<AbortController>();

  const settleIfDrained = () => {
    if (closed && outstanding === 0) {
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    }
  };

  return {
    get outstanding() {
      return outstanding;
    },
    get closed() {
      return closed;
    },
    admit() {
      if (closed) return null;
      outstanding += 1;
      const controller = new AbortController();
      controllers.add(controller);
      let released = false;
      return {
        controller,
        release: () => {
          if (released) return;
          released = true;
          controllers.delete(controller);
          outstanding -= 1;
          settleIfDrained();
        },
      };
    },
    close() {
      closed = true;
      const toAbort = [...controllers];
      controllers.clear();
      for (const controller of toAbort) controller.abort();
      settleIfDrained();
      if (outstanding === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
