import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@cockpit-context/env/shared";

/**
 * Lock slots: at most this many transactions in this process hold (or wait
 * for) one of the per-user advisory locks at once (password-write,
 * user-credential, set-password-link: see oauth-revocation.ts and
 * password-write-lock.ts). Each pins a pooled connection while the work it
 * protects (a Better-Auth handler, an insert) needs another, so if lock
 * transactions could fill the pool, nothing would make progress until a
 * timeout. Capping them one below the pool size always leaves a connection
 * for that work.
 *
 * A holder that will itself run a nested lock transaction (a password write
 * runs the credential revocation inside its handler) reserves the nested slot
 * up front, together with its own, so it can never wait for a slot while
 * holding one. That is why `DATABASE_POOL_MAX` is at least 3.
 */
const LOCK_SLOTS = Math.max(1, env.DATABASE_POOL_MAX - 1);
let slotsInUse = 0;
type SlotWaiter = { count: number; resolve: () => void };
const slotWaiters: SlotWaiter[] = [];

/** Take `count` slots now, or answer false (never jumps the queue). */
export function tryAcquireSlots(count = 1): boolean {
  if (slotWaiters.length > 0 || slotsInUse + count > LOCK_SLOTS) return false;
  slotsInUse += count;
  return true;
}

/** Hand free slots to waiters in arrival order. */
function admitWaiters(): void {
  for (let next = slotWaiters[0]; next; next = slotWaiters[0]) {
    if (slotsInUse + next.count > LOCK_SLOTS) break;
    slotWaiters.shift();
    slotsInUse += next.count;
    next.resolve();
  }
}

/** Give `count` slots back, handing them to waiters in arrival order. */
export function releaseSlots(count = 1): void {
  slotsInUse -= count;
  admitWaiters();
}

/** No lock slot came free before the caller's deadline. */
export class LockSlotTimeoutError extends Error {
  constructor() {
    super("No lock slot came free before the deadline.");
    this.name = "LockSlotTimeoutError";
  }
}

/**
 * Wait in line for `count` slots. With a `deadline` (a `performance.now()`
 * timestamp), a waiter still queued then leaves the queue (so it no longer
 * holds up the ones behind it) and the wait rejects with
 * {@link LockSlotTimeoutError}.
 */
function waitForSlots(count: number, deadline: number | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const waiter: SlotWaiter = {
      count,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    slotWaiters.push(waiter);
    if (deadline === undefined) return;
    timer = setTimeout(
      () => {
        const at = slotWaiters.indexOf(waiter);
        if (at < 0) return; // already admitted
        slotWaiters.splice(at, 1);
        // A large request at the head may have been all that held back
        // smaller ones behind it.
        admitWaiters();
        reject(new LockSlotTimeoutError());
      },
      Math.max(0, deadline - performance.now()),
    );
  });
}

/** Slots a holder reserved for the nested lock transaction it runs. */
const reservedFor = new AsyncLocalStorage<{ spare: number }>();

/**
 * Run `fn` (a transaction that takes, and may wait for, an advisory lock) in
 * a lock slot. Waits for the slot in memory, holding no connection. Inside a
 * holder that reserved a nested slot, the reserved one is used instead (never
 * waited for, so a nested revocation cannot be starved or time out).
 * `nested` reserves that many extra slots for `fn`'s own nested lock
 * transactions. `deadline` (a `performance.now()` timestamp) bounds the wait
 * for a slot: past it the call rejects with {@link LockSlotTimeoutError}
 * without running `fn`.
 */
export async function withLockSlot<T>(
  fn: () => Promise<T>,
  { nested = 0, deadline }: { nested?: number; deadline?: number } = {},
): Promise<T> {
  const reservation = reservedFor.getStore();
  if (nested === 0 && reservation && reservation.spare > 0) {
    reservation.spare -= 1;
    try {
      return await fn();
    } finally {
      reservation.spare += 1;
    }
  }
  const count = 1 + nested;
  if (!tryAcquireSlots(count)) await waitForSlots(count, deadline);
  try {
    return nested > 0 ? await reservedFor.run({ spare: nested }, fn) : await fn();
  } finally {
    releaseSlots(count);
  }
}
