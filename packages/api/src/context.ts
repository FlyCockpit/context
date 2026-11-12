import { auth, type Session } from "@cockpit-context/auth";
import type { Context as HonoContext } from "hono";

/**
 * How the caller authenticated. Absent on every cookie surface (`/rpc`, the
 * OpenAPI reference); set only by a bearer-credential
 * surface (the removed companion CLI shipped one):
 *
 * - `"session-token"` — a device-flow session (`mycli login`). A full session
 *   of the user who approved it in a signed-in browser.
 * - `"api-key"` — a long-lived key. `requireAdmin` / `requireAdminOr404`
 *   reject it: admin work needs a session that went through sign-in and 2FA.
 */
export type CredentialKind = "session-token" | "api-key";

export type CreateContextOptions = {
  context: HonoContext;
  /** Resolved once per HTTP request by the Hono layer (never by a procedure). */
  clientIp?: string;
};

export async function createContext({ context, clientIp }: CreateContextOptions) {
  // The session is resolved once per request by `sessionMiddleware` in
  // apps/server. Test harnesses that bypass the Hono middleware stack will
  // see undefined here — fall back to a direct lookup so they still work.
  const preresolved = context.get("session") as Session | null | undefined;
  if (preresolved !== undefined) {
    const credential = context.get("credential") as CredentialKind | undefined;
    return { session: preresolved, clientIp, credential };
  }
  // Fallback path. Strip `Authorization` for the same reason sessionMiddleware
  // does: a Better-Auth plugin that adds a bearer credential would otherwise
  // mock a session for its owner here, and oRPC procedures never check a
  // credential's scope. oRPC is a cookie-authenticated surface.
  const cookieOnly = new Headers(context.req.raw.headers);
  cookieOnly.delete("authorization");
  const session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  return {
    session,
    clientIp,
    credential: undefined as CredentialKind | undefined,
  };
}

// `credential` is optional so test harnesses and cookie-surface callers can
// build a context without it (absent = cookie session).
export type Context = Omit<Awaited<ReturnType<typeof createContext>>, "credential"> & {
  credential?: CredentialKind;
};
