/**
 * Ordering rules for the home's Pinned section (pure, so the drag and the
 * keyboard share them and tests need no DOM).
 */

/** `ids` with the item at `from` moved to `to` (both clamped); a new array. */
export function moveItem<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = ids.slice();
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1) as [T];
  next.splice(target, 0, item);
  return next;
}

/**
 * Where a dragged row belongs while the pointer is at `pointerY`: the number
 * of the OTHER rows whose vertical middle is above the pointer. Measuring
 * middles (not edges) keeps rows of different heights from swapping back and
 * forth under a still pointer.
 */
export function dropIndex(
  rows: readonly { id: string; top: number; height: number }[],
  draggedId: string,
  pointerY: number,
): number {
  let index = 0;
  for (const row of rows) {
    if (row.id === draggedId) continue;
    if (row.top + row.height / 2 < pointerY) index += 1;
  }
  return index;
}

/** Same members, same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Same members, in any order. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Saves the pin order without ever overlapping two saves, shared by every
 * mount of the Pinned section (one per QueryClient), so leaving the home and
 * coming back cannot start a second, racing queue.
 *
 * `desired()` is the order the user last asked for while saves are pending
 * (null when nothing is pending): the section shows it, so a background
 * re-read that returns an older server order cannot undo a move still being
 * saved. While one save is in flight the newest order waits (older waiting
 * ones are dropped) and is sent when it returns. `onSaved` gets every order
 * the server acknowledged, so after a failure the last acknowledged order is
 * what remains (a failure drops what was waiting); `onDrained` runs once the
 * queue is empty.
 */
export interface OrderSaver {
  desired: () => string[] | null;
  subscribe: (listener: () => void) => () => void;
  save: (ids: string[]) => void;
}

export function createOrderSaver(options: {
  send: (ids: string[]) => Promise<unknown>;
  onSaved: (ids: string[]) => void | Promise<void>;
  onDrained: (result: "saved" | "failed") => void;
}): OrderSaver {
  let desired: string[] | null = null;
  let next: string[] | null = null;
  let running = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const drain = async () => {
    running = true;
    let result: "saved" | "failed" = "saved";
    try {
      while (next !== null) {
        const order = next;
        next = null;
        await options.send(order);
        await options.onSaved(order);
      }
    } catch {
      next = null;
      result = "failed";
    }
    running = false;
    desired = null;
    notify();
    options.onDrained(result);
  };

  return {
    desired: () => desired,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save: (ids) => {
      desired = ids;
      next = ids;
      notify();
      if (!running) void drain();
    },
  };
}
