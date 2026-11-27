import { isUserBanned, onUserBanned } from "@cockpit-context/auth/ban";
import { hasLiveSession } from "@cockpit-context/auth/oauth-revocation";
import prisma, { type Prisma } from "@cockpit-context/db";
import { env } from "@cockpit-context/env/server";
import { ORPCError } from "@orpc/server";

/**
 * Live streams (`conversations.watch` + `conversations.activity`, combined)
 * one user may hold open at once: `COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER`,
 * read on every open. Each is a long-lived HTTP response with a bus
 * subscription behind it, and the `/rpc` limiter counts only the request that
 * opened it. One tab holds one `activity` and at most one `watch`; the
 * default 20 is a person with ten tabs open.
 *
 * The registry also ends them on a ban or password recovery. A stream is admitted once, when it
 * opens; nothing on the request path re-checks it afterwards. So every
 * application ban path announces the ban (`announceUserBanned`,
 * packages/auth/src/ban.ts) and {@link closeUserLiveStreams} aborts each of
 * the user's open streams; the handler then fails it with `UNAUTHORIZED`.
 *
 * In-process, like every limiter and bus here: one app replica
 * (docs/hosting.md).
 */
const liveStreams = new Map<string, Set<AbortController>>();

/** Why a stream was closed by the registry rather than by its client. */
const BANNED = Symbol("live-stream-banned");

export type LiveStream = {
  /**
   * Aborts when the client disconnects OR the user is banned. Pass it to the
   * bus subscription.
   */
  signal: AbortSignal;
  /** True once a ban closed the stream. */
  closedByBan: () => boolean;
  /**
   * Throws `UNAUTHORIZED` once a ban closed the stream. Call it before every
   * `yield`: the bus iterator ends on abort but still hands out what it had
   * buffered, and nothing may reach a banned user after the announcement.
   */
  assertOpen: () => void;
  /**
   * Await `work`, but reject with `UNAUTHORIZED` as soon as a ban closes the
   * stream (the snapshot read is not abortable itself; its late result is
   * dropped).
   */
  untilBanned: <T>(work: Promise<T>) => Promise<T>;
  /** Idempotent. Call it in a `finally` that covers every exit, client abort included. */
  release: () => void;
};

const banStateSelect = { banned: true, banExpires: true } satisfies Prisma.UserSelect;

/**
 * Takes one of the user's live-stream slots, or refuses with
 * `TOO_MANY_REQUESTS` (the web client retries with backoff, so a slot freed
 * by closing a tab is picked up).
 *
 * Then re-reads the session and the user's ban state from the database, and refuses with
 * `UNAUTHORIZED` if they are banned or gone. The session that admitted the
 * request may be a signed cookie-cache copy from up to 60 s before a ban
 * (`checkSessionAccess`, packages/api/src/index.ts), so without this read a
 * stream opened in that window would outlive the ban announcement it missed.
 * The slot is registered BEFORE the read: a ban announced after registration
 * aborts it, and one committed before the read is seen by it, so no ordering
 * lets a stream slip between the two.
 */
export async function openLiveStream(
  userId: string,
  sessionId: string,
  requestSignal?: AbortSignal,
): Promise<LiveStream> {
  const open = liveStreams.get(userId);
  if ((open?.size ?? 0) >= env.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "Too many live views are open. Close some tabs and try again.",
    });
  }
  const controller = new AbortController();
  const slots = open ?? new Set<AbortController>();
  slots.add(controller);
  liveStreams.set(userId, slots);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = liveStreams.get(userId);
    if (!current) return;
    current.delete(controller);
    if (current.size === 0) liveStreams.delete(userId);
  };

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: banStateSelect });
    if (!user || isUserBanned(user) || !(await hasLiveSession(prisma, userId, sessionId)))
      throw new ORPCError("UNAUTHORIZED");
  } catch (error) {
    release();
    throw error;
  }
  if (controller.signal.aborted) {
    release();
    throw new ORPCError("UNAUTHORIZED");
  }

  const closedByBan = () => controller.signal.aborted && controller.signal.reason === BANNED;
  const banClosed = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new ORPCError("UNAUTHORIZED")), {
      once: true,
    });
  });
  // Never an unhandled rejection when nothing is awaiting it.
  banClosed.catch(() => {});
  return {
    signal: requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal,
    closedByBan,
    assertOpen: () => {
      if (closedByBan()) throw new ORPCError("UNAUTHORIZED");
    },
    untilBanned: (work) => Promise.race([work, banClosed]),
    release,
  };
}

/** Aborts every open live stream of the user. Returns how many it closed. */
function closeUserLiveStreams(userId: string): number {
  const slots = liveStreams.get(userId);
  if (!slots) return 0;
  let closed = 0;
  for (const controller of slots) {
    if (controller.signal.aborted) continue;
    controller.abort(BANNED);
    closed += 1;
  }
  return closed;
}

/** Open slots per user, for tests. */
export function liveStreamCount(userId: string): number {
  return liveStreams.get(userId)?.size ?? 0;
}

onUserBanned((userId) => {
  closeUserLiveStreams(userId);
});
