import { auth, type Session } from "@cockpit-context/auth";
import type { Context, Next } from "hono";

// Resolves the Better-Auth session once per request and stashes it on the
// Hono context. Downstream consumers (rate limiter, oRPC createContext) read
// `c.get("session")` instead of each making
// their own database hit.
//
// Failure mode: a Better-Auth blip becomes "no session" rather than a 500
// for the entire request. The downstream `requireAuth` gates will still
// return 401 if a real session was needed.
//
// SECURITY: `Authorization` is stripped before resolving, so the routes this
// middleware guards (/rpc/*) authenticate by cookie ONLY.
//
// Defense in depth. A Better-Auth plugin that accepts a bearer token (an
// API-key or bearer plugin, for one) typically mocks a session for the token's
// owner inside `getSession`, while no oRPC procedure here checks a
// credential's scope.
// Stripping the header keeps that from silently turning these cookie surfaces
// into token surfaces. A future bearer surface must resolve and
// label its own credential rather than relax this.
export async function sessionMiddleware(c: Context, next: Next) {
  let session: Session | null = null;
  try {
    const cookieOnly = new Headers(c.req.raw.headers);
    cookieOnly.delete("authorization");
    session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  } catch (err) {
    console.warn("[session-middleware] getSession failed, treating as anonymous:", err);
    session = null;
  }
  c.set("session", session ?? null);
  await next();
}
