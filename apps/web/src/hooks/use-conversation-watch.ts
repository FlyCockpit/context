import { useEffect, useReducer, useState } from "react";

import { applyWatchEvent, type ConversationViewState, type WatchEvent } from "@/lib/conversations";
import { consumeWithReconnect, type StreamStatus } from "@/lib/stream-reconnect";
import { errorCode } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/** Retrying cannot help: the conversation is not the viewer's (or is gone), or the session ended. */
function isFatal(error: unknown): boolean {
  const code = errorCode(error);
  return code === "NOT_FOUND" || code === "UNAUTHORIZED" || code === "BAD_REQUEST";
}

/**
 * The live view of one conversation: `conversations.watch` folded into
 * {@link ConversationViewState} (snapshot first, then every event), kept
 * subscribed across drops with a fresh snapshot on each reconnect. `state`
 * stays on screen while reconnecting. `resubscribe()` forces a new snapshot
 * (after a follow-up starts, say).
 */
export function useConversationWatch(conversationId: string) {
  const [state, dispatch] = useReducer(
    (current: ConversationViewState | null, event: WatchEvent | null) =>
      event === null ? null : applyWatchEvent(current, event),
    null,
  );
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [failure, setFailure] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the resubscribe trigger.
  useEffect(() => {
    const controller = new AbortController();
    dispatch(null);
    setFailure(null);
    void consumeWithReconnect<WatchEvent>({
      signal: controller.signal,
      connect: (signal) => orpc.conversations.watch.call({ id: conversationId }, { signal }),
      onEvent: dispatch,
      onStatus: (next, error) => {
        setStatus(next);
        if (next === "failed") setFailure(error ?? null);
      },
      isFatal,
    });
    return () => controller.abort();
  }, [conversationId, generation]);

  return {
    state,
    status,
    failure,
    resubscribe: () => setGeneration((value) => value + 1),
  };
}
