/**
 * Ban-state predicate, shared by every surface that authenticates without going
 * through Better-Auth's own session-creation path.
 *
 * It lives here, dependency-free, so that every surface which re-implements the
 * admin rules for its own credential type applies an identical check. The
 * Better-Auth plugin gate (`apps/server/src/admin-session-gate.ts`) is the
 * current caller; keep new credential-resolving surfaces on this predicate
 * rather than re-deriving the ban rule.
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
