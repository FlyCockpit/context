import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { type QueryClient, type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { createOrderSaver, type OrderSaver } from "@/lib/pins";
import { orpc } from "@/utils/orpc";

/**
 * The signed-in user's pinned conversations (`pins.list`, at most `limit`),
 * shared by the home's Pinned section, every row menu and the conversation
 * page (TanStack Query dedupes it).
 */
export function usePins() {
  return useQuery(orpc.pins.list.queryOptions());
}

/** What a pin toggle needs to know: is it pinned, and is there room for one more. */
export function usePinState(conversationId: string) {
  const pins = usePins();
  const items = pins.data?.items ?? [];
  const pinned = items.some((item) => item.id === conversationId);
  return {
    /** False until the pins are known: the toggle waits rather than guessing. */
    ready: pins.data !== undefined,
    pinned,
    /** Pinning one more would pass the limit (unpinning always works). */
    full: pins.data ? !pinned && items.length >= pins.data.limit : false,
    limit: pins.data?.limit ?? 0,
  };
}

/** Pin or unpin one conversation, with a short confirmation and a fresh Pinned section. */
export function usePinToggle() {
  const { t } = useTranslation(["dashboard"]);
  const invalidateKey = orpc.pins.key();
  const pin = useEntityMutation(orpc.pins.pin.mutationOptions(), {
    invalidateKey,
    successMessage: t("dashboard:pins.pinnedToast"),
  });
  const unpin = useEntityMutation(orpc.pins.unpin.mutationOptions(), {
    invalidateKey,
    successMessage: t("dashboard:pins.unpinnedToast"),
  });
  return {
    toggle: (id: string, pinned: boolean) => (pinned ? unpin.mutate({ id }) : pin.mutate({ id })),
    isPending: pin.isPending || unpin.isPending,
  };
}

export type PinsData = Awaited<ReturnType<AppRouterClient["pins"]["list"]>>;

/** The cached list in `ids` order; unchanged if the members differ. */
function inOrder(current: PinsData | undefined, ids: readonly string[]) {
  if (!current) return current;
  const byId = new Map(current.items.map((item) => [item.id, item]));
  const items = ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  return items.length === current.items.length ? { ...current, items } : current;
}

/**
 * The order saver wired to one QueryClient's cached pin list. Each order the
 * server acknowledged goes into the cache, after cancelling any re-read in
 * flight: one that started before the save could otherwise land after it and
 * put the older order back (a re-read that starts later already sees the
 * saved order). So when a later save fails, the list shows the last order
 * the server actually has. The list is re-read once the queue drains.
 */
export function pinOrderSaver(
  queryClient: QueryClient,
  listKey: QueryKey,
  send: (ids: string[]) => Promise<unknown>,
): OrderSaver {
  return createOrderSaver({
    send,
    onSaved: async (ids) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      queryClient.setQueryData<PinsData>(listKey, (current) => inOrder(current, ids));
    },
    onDrained: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

/** One order saver per QueryClient (the app has one), shared by every mount. */
const savers = new WeakMap<QueryClient, OrderSaver>();

function orderSaver(queryClient: QueryClient): OrderSaver {
  const existing = savers.get(queryClient);
  if (existing) return existing;
  // Built in the MutationCache like any useMutation, so the global error
  // toast says why a save failed; not tied to a component's lifetime.
  const saver = pinOrderSaver(queryClient, orpc.pins.list.queryKey(), (ids) =>
    queryClient
      .getMutationCache()
      .build(queryClient, orpc.pins.reorder.mutationOptions())
      .execute({ ids }),
  );
  savers.set(queryClient, saver);
  return saver;
}

/**
 * Save a new order (`pins.reorder`). `desired` is the order still being
 * saved, if any: show it instead of the cached list, so neither a background
 * re-read nor leaving and re-entering the home undoes a move in flight. On a
 * failure (pins changed elsewhere, offline) the list falls back to the last
 * order the server acknowledged and is re-read; the global toast says why.
 */
export function usePinReorder() {
  const saver = orderSaver(useQueryClient());
  const desired = useSyncExternalStore(saver.subscribe, saver.desired, () => null);
  return { save: saver.save, desired };
}
