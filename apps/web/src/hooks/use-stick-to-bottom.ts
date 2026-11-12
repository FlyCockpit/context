import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** How close to the bottom still counts as "at the live edge". */
const BOTTOM_SLACK_PX = 64;

/**
 * Auto-scroll for a live transcript (adapted from the template chat's
 * `useStickToBottom`).
 *
 * Following is on when the transcript opens and whenever the reader is at
 * the bottom: new activity keeps them pinned to the live edge. Scrolling up
 * (or pressing into the transcript to select text) pauses it, and new
 * activity then raises `hasUnseenActivity` for a "jump to latest" button
 * instead of moving the viewport. Reaching the bottom again resumes.
 *
 * `activityKey` changes whenever rendered content changes; `resetKey`
 * (the conversation id) starts over at the bottom.
 *
 * `containerRef` is a callback ref that holds the scroller in state: the page
 * renders a skeleton first, so the element mounts after this hook does, and
 * the resize observer has to re-attach when it arrives.
 */
export function useStickToBottom(activityKey: string, resetKey: string) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState({ resetKey, following: true, seenKey: activityKey });
  const current =
    anchor.resetKey === resetKey ? anchor : { resetKey, following: true, seenKey: activityKey };
  const following = current.following;
  const hasUnseenActivity = !following && current.seenKey !== activityKey;

  const scrollToLatest = useCallback(() => {
    if (container) container.scrollTop = container.scrollHeight;
  }, [container]);

  const setFollowing = useCallback(
    (next: boolean) => {
      setAnchor((previous) => {
        if (previous.resetKey === resetKey && previous.following === next) return previous;
        return { resetKey, following: next, seenKey: activityKey };
      });
      if (next) scrollToLatest();
    },
    [activityKey, resetKey, scrollToLatest],
  );

  const onScroll = useCallback(() => {
    if (!container) return;
    const atLiveEdge =
      container.scrollHeight - container.scrollTop - container.clientHeight < BOTTOM_SLACK_PX;
    setAnchor((previous) => {
      if (previous.resetKey === resetKey && previous.following === atLiveEdge) return previous;
      return { resetKey, following: atLiveEdge, seenKey: activityKey };
    });
  }, [activityKey, container, resetKey]);

  /** A press inside the transcript (text selection, opening a row) stops the yank. */
  const pauseFollowing = useCallback(() => {
    setAnchor((previous) =>
      previous.resetKey === resetKey && !previous.following
        ? previous
        : { resetKey, following: false, seenKey: activityKey },
    );
  }, [activityKey, resetKey]);

  // Pin a following reader to the live edge before paint, so streamed text
  // never flashes above the fold first. `scrollToLatest` changes when the
  // scroller mounts, which pins the transcript the moment it replaces the
  // skeleton.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is the re-run trigger — each bit of new content must re-pin a following reader.
  useLayoutEffect(() => {
    if (following) scrollToLatest();
  }, [activityKey, following, scrollToLatest]);

  // A resized viewport (mobile keyboard, rotating) keeps a follower at the bottom.
  useEffect(() => {
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following) scrollToLatest();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, following, scrollToLatest]);

  return {
    containerRef: setContainer,
    following,
    hasUnseenActivity,
    onScroll,
    pauseFollowing,
    jumpToLatest: () => setFollowing(true),
  };
}
