import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { ActivityEvent } from "@/lib/conversations";
import { consumeWithReconnect } from "@/lib/stream-reconnect";
import { errorCode } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/**
 * Re-reads are coalesced. A run appearing, starting or finishing changes what
 * a row says, so it is shown within this window — as is the `ready` marker on
 * every (re)subscribe.
 */
const STRUCTURAL_REFRESH_MS = 1_500;

/**
 * A running investigation reports progress (and phase and helper changes)
 * after every model step; one re-read per this window is plenty to show it.
 * The list refetch re-reads every loaded page, so it is worth spacing out.
 */
const PROGRESS_REFRESH_MS = 5_000;

/** The coalescing window an activity hint asks for. */
export function refreshWindowFor(event: ActivityEvent): number {
  if (event.type !== "activity") return STRUCTURAL_REFRESH_MS;
  switch (event.change) {
    case "progress":
    case "phase":
    case "helper":
      return PROGRESS_REFRESH_MS;
    default:
      return STRUCTURAL_REFRESH_MS;
  }
}

/**
 * One pending flush at a time: a hint schedules it `windowMs` out unless one
 * is already due sooner, and a hint with a shorter window pulls a later
 * pending flush forward — so a run finishing during a progress window still
 * shows within the structural window.
 */
export function createRefreshCoalescer(flush: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;
  return {
    schedule(windowMs: number) {
      const at = Date.now() + windowMs;
      if (timer !== null) {
        if (at >= dueAt) return;
        clearTimeout(timer);
      }
      dueAt = at;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, windowMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Keep the conversation lists live: subscribe to `conversations.activity`
 * (change hints for the viewer's own runs) and refetch `conversations.list`
 * and `home.status` when something changed — once on (re)subscribe too,
 * which covers anything that happened while disconnected.
 */
export function useRunActivity() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();
    const refresh = createRefreshCoalescer(() => {
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.home.status.key() });
    });
    void consumeWithReconnect<ActivityEvent>({
      signal: controller.signal,
      connect: (signal) => orpc.conversations.activity.call(undefined, { signal }),
      onEvent: (event) => refresh.schedule(refreshWindowFor(event)),
      onStatus: () => {},
      isFatal: (error) => errorCode(error) === "UNAUTHORIZED",
    });
    return () => {
      controller.abort();
      refresh.cancel();
    };
  }, [queryClient]);
}
