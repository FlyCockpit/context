/**
 * Ban-state predicate, shared by every surface that authenticates without going
 * through Better-Auth's own session-creation path.
 *
 * It lives here, dependency-free, so that every surface which re-implements the
 * session rules for its own credential type applies an identical check. The
 * signed-in-user rule (`checkSessionAccess` in `packages/api/src/index.ts`,
 * behind `requireAuth` and so every authenticated procedure, and the first step
 * of `checkAdminAuthority`, behind `requireAdmin`, `requireAdminOr404` and
 * `apps/server/src/admin-session-gate.ts`),
 * the web admin route guard's session projection
 * (`apps/web/src/server/auth-session.ts`) and the MCP/OAuth credential
 * resolution (`apps/server/src/mcp/credentials.ts`) call it; keep new
 * credential-resolving surfaces on this predicate rather than re-deriving the
 * ban rule.
 *
 * Why any of them need it: the admin plugin only rejects a banned user when a
 * session is CREATED (`session.create.before`). It never re-checks on
 * `getSession`, and with the 60s cookie cache an already-issued session keeps
 * working for up to a minute after a ban. Credentials that are not sessions at
 * all — MCP API tokens and OAuth access tokens — are never re-checked by the
 * plugin on any request. `users.archive` therefore sets `banned`, deletes
 * sessions and revokes every MCP token and OAuth connection, and these gates
 * close the remaining windows.
 */
export function isUserBanned(user: {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}): boolean {
  if (!user.banned) return false;
  // A lapsed temporary ban is not a ban. `banExpires: null` on a banned user
  // means permanent — that is what `users.archive` writes.
  //
  // `banExpires` is accepted as a string as well as a Date, and that is not
  // defensive padding: on a Better-Auth cookie-cache HIT the session user is
  // revived from base64(JSON) and only `createdAt`/`updatedAt` are re-hydrated
  // into Dates (`better-auth/dist/api/routes/session.mjs:110-114`), so
  // `banExpires` arrives as an ISO string. Calling `.getTime()` on it throws a
  // TypeError, which — for a LAPSED ban, where the correct answer is "allow" —
  // turned a legitimate admin's request into a 500 until the cache expired.
  const expiresAt = user.banExpires ? new Date(user.banExpires).getTime() : null;
  // An unparseable value is treated as "no expiry", i.e. still banned. Failing
  // closed is right: this predicate only ever gates access.
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= Date.now()) return false;
  return true;
}

/**
 * Where a ban came from. `application`: `users.archive` and account removal,
 * which also stop the user's runs themselves. `auth-plugin`: the admin
 * plugin's `/admin/ban-user` / `/admin/update-user`, which stop nothing, so a
 * listener does it (packages/api/src/routers/users.ts). `session-revocation`:
 * password recovery; closes streams and MCP exchanges without stopping runs.
 */
/** Verification identifier prefix holding an admin archive-undo snapshot. */
export const ARCHIVE_UNDO_IDENTIFIER_PREFIX = "archive-undo:";

/** Verification identifier for one user's pending admin archive-undo record. */
export function archiveUndoIdentifier(userId: string): string {
  return `${ARCHIVE_UNDO_IDENTIFIER_PREFIX}${userId}`;
}

/** Acquires the per-user credential advisory lock on an open transaction client. */
export function lockUserCredentials(
  tx: {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  },
  userId: string,
) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028274, hashtext(${userId}))`;
}

export type BanOrigin = "application" | "auth-plugin" | "session-revocation";
type BanListener = (userId: string, origin: BanOrigin) => void;
const banListeners = new Set<BanListener>();

/**
 * Subscribe to user access teardown (ban or session revocation). The live-stream registry
 * (`packages/api/src/lib/live-streams.ts`) uses it to close the user's open
 * `conversations.watch` / `conversations.activity` subscriptions, which are
 * admitted once when they open and are otherwise never re-checked.
 * Process-local, like every event bus here: one app replica (docs/hosting.md).
 * Returns the unsubscribe.
 */
export function onUserBanned(listener: BanListener): () => void {
  banListeners.add(listener);
  return () => {
    banListeners.delete(listener);
  };
}

/**
 * Announce a committed ban. Call it AFTER the write that sets `banned` has
 * committed: a listener may re-read the user. Every application ban path does:
 * `users.archive`, `prepareUserDeletion` (packages/api/src/lib/user-deletion.ts)
 * and, for the admin plugin's `/admin/ban-user` and `/admin/update-user`, the
 * `databaseHooks.user.update.after` hook in ./index.ts (Better-Auth queues
 * that hook until the transaction commits). A ban written straight to the
 * database announces nothing; see `checkSessionAccess` for what still bounds it.
 *
 * A listener that throws is logged and skipped, so one consumer cannot stop
 * the others from closing what they hold.
 */
export function announceUserBanned(userId: string, origin: BanOrigin = "application"): void {
  for (const listener of banListeners) {
    try {
      listener(userId, origin);
    } catch (error) {
      const label = error instanceof Error ? error.name : typeof error;
      console.error("[ban] a ban listener failed:", label);
    }
  }
}

/**
 * The `databaseHooks.user.update.after` step (./index.ts): announce the ban
 * when the user as written is banned. Better-Auth's admin plugin bans through
 * `internalAdapter.updateUser` (`/admin/ban-user`, `/admin/update-user`), and
 * queues this hook until the write commits.
 */
export function announceIfUserBanned(user: {
  id: string;
  banned?: boolean | null;
  banExpires?: Date | string | null;
}): void {
  if (isUserBanned(user)) announceUserBanned(user.id, "auth-plugin");
}

/** Recovery uses the same connection teardown as bans, without banning the user
 * or stopping their runs. Existing MCP requests subscribe to this bus too.
 */
export function announceUserSessionsRevoked(userId: string): void {
  announceUserBanned(userId, "session-revocation");
}
