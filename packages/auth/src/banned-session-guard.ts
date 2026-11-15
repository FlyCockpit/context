import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSession } from "better-auth/api";

import { isUserBanned } from "./ban";

/**
 * Better-Auth paths a banned user's session may still reach. Only sign-out:
 * it deletes the session and clears the cookie, which is exactly what a
 * banned user's browser should do with it.
 */
export const BANNED_SESSION_ALLOWED_PATHS: ReadonlySet<string> = new Set(["/sign-out"]);

/** The admin plugin's ban fields, which the base session user type does not declare. */
function banStateOf(user: object): { banned: boolean; banExpires: Date | string | null } {
  const banned = Reflect.get(user, "banned");
  const banExpires = Reflect.get(user, "banExpires");
  return {
    banned: banned === true,
    banExpires: banExpires instanceof Date || typeof banExpires === "string" ? banExpires : null,
  };
}

type GuardContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * The session for this request, as Better-Auth's `getSessionFromCtx` resolves
 * it (cookie cache included, result cached on `ctx.context.session` for the
 * endpoint), but without its `.catch(() => null)`: a lookup that FAILS (the
 * database is unreachable) must not read as "no session" and let the request
 * through to an endpoint that retries the lookup without the ban check. A
 * failure propagates, so the request fails closed.
 */
async function resolveSessionFailingClosed(ctx: GuardContext) {
  if (ctx.context.session) return ctx.context.session;
  const result = await getSession()({
    ...ctx,
    method: "GET",
    asResponse: false,
    headers: ctx.headers ?? new Headers(),
    returnHeaders: true,
    returnStatus: false,
    query: { ...ctx.query },
  });
  if (!result?.response) {
    ctx.context.session = null;
    return null;
  }
  result.headers?.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "cache-control" || lower === "pragma") return;
    if (lower === "set-cookie") ctx.responseHeaders?.append(key, value);
    else ctx.responseHeaders?.set(key, value);
  });
  ctx.context.session = result.response;
  return result.response;
}

/**
 * Refuses every `/api/auth/*` request that carries a banned user's session,
 * except {@link BANNED_SESSION_ALLOWED_PATHS}.
 *
 * Why: the admin plugin checks `banned` only when a session is CREATED. Every
 * application ban path deletes the user's sessions (`users.archive`,
 * `prepareUserDeletion`, and the plugin's own `/admin/ban-user` and
 * `/admin/update-user`), but a ban written any other way (a direct DB write)
 * leaves a session that `getSession` keeps resolving. oRPC, the admin gates
 * and MCP re-check the ban themselves (`isUserBanned`); Better-Auth's own
 * routes did not, so a surviving session could still update the profile, set
 * up 2FA or approve an MCP OAuth consent (`/oauth2/consent`,
 * `/oauth2/continue`). This hook closes that.
 *
 * Scope:
 * - Only HTTP requests through `auth.handler` (`ctx.request` is set). Server-side
 *   `auth.api.*` calls (the oRPC context, the admin gates, the web route guard,
 *   `users.invite`) resolve the session themselves and apply `isUserBanned`
 *   with their own response; throwing inside them would turn a refusal into a
 *   500.
 * - The answer is 401 with no detail, as oRPC answers a banned user. The web
 *   session hook maps a 401 from `get-session` to "anonymous"
 *   (apps/web/src/lib/auth-session-state.ts).
 * - A session lookup that fails (not "no session": an error) fails the
 *   request rather than passing it on unchecked.
 * - Requests without a session pass untouched: sign-in, sign-up and the OAuth
 *   token endpoint never carry one, and a banned user cannot sign in anyway
 *   (the admin plugin's `session.create.before`).
 *
 * Bound: the session is the one Better-Auth resolves for the request, so on a
 * signed cookie-cache hit the user is the copy from up to `cookieCache.maxAge`
 * (60 s) ago. A ban therefore takes effect here within 60 s, the same bound as
 * every other surface (`checkSessionAccess`, packages/api/src/index.ts).
 *
 * Register it FIRST in `plugins` so it runs before any other plugin's before
 * hooks (the OAuth provider's included).
 */
export function bannedSessionGuard() {
  return {
    id: "cockpit-context-banned-session-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.request !== undefined && !BANNED_SESSION_ALLOWED_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await resolveSessionFailingClosed(ctx);
            const user = session?.user;
            // `banned` / `banExpires` are the admin plugin's fields; the
            // base session type does not declare them.
            if (user && isUserBanned(banStateOf(user))) {
              // Finish what every ban path does: delete the user's sessions.
              // The surviving cookie then stops resolving once its cache
              // copy (<= 60 s) lapses, so the browser is not stuck refusing
              // even a different account's sign-in until it signs out.
              try {
                await ctx.context.internalAdapter.deleteUserSessions(user.id);
              } catch {
                // The refusal below stands either way.
              }
              throw new APIError("UNAUTHORIZED", { message: "Unauthorized", code: "UNAUTHORIZED" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
