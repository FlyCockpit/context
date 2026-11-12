/**
 * Listeners told that checkouts are about to lose their worktrees (deleted,
 * pruned, or removed with their repository). The run engine registers the
 * LSP manager's `stopCheckout` here, so no language server outlives — or
 * holds files open in — a removed checkout.
 */
export type CheckoutRemovalListener = (checkoutIds: readonly string[]) => void | Promise<void>;

const listeners = new Set<CheckoutRemovalListener>();

/** Register a listener; returns its unregister function. */
export function onCheckoutRemoval(listener: CheckoutRemovalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run every listener before the worktrees go. A failing listener is logged and
 * never blocks the removal.
 */
export async function notifyCheckoutRemoval(checkoutIds: readonly string[]): Promise<void> {
  if (checkoutIds.length === 0 || listeners.size === 0) return;
  await Promise.all(
    [...listeners].map(async (listener) => {
      try {
        await listener(checkoutIds);
      } catch (error) {
        console.warn("[repos] checkout removal listener failed", error);
      }
    }),
  );
}
