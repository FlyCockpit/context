// Load repo-root `.env` before any `@cockpit-context/env/*` validation (and before
// packages that import it: auth, db, api). Must stay the first import.
import "@cockpit-context/env/load-dotenv";

import { createHash } from "node:crypto";
import { type CredentialKind, createContext } from "@cockpit-context/api/context";
import { appRouter } from "@cockpit-context/api/routers/index";
import { auth, type Session } from "@cockpit-context/auth";
import { issueBootstrapTokenIfNeeded } from "@cockpit-context/auth/bootstrap-token";
import { getSignupAvailability } from "@cockpit-context/auth/signup-availability";
import { ORPC_BATCH_MAX_SIZE } from "@cockpit-context/config/orpc-batch";
import { THEME_INIT_SCRIPT } from "@cockpit-context/config/theme-init";
import prisma from "@cockpit-context/db";
import { ADMIN_EMAILS, env } from "@cockpit-context/env/server";
import { serve } from "@hono/node-server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { apiReferenceAdminGate } from "./api-reference-admin-gate.js";
import { betterAuthAdminGate } from "./better-auth-admin-gate.js";
import { readBuildCommit } from "./build-commit.js";
import { resolveClientIp } from "./client-ip.js";
import { CORS_ALLOW_HEADERS } from "./cors-headers.js";
import {
  EMAIL_RECIPIENT_PATHS,
  emailRecipientLimit,
  FORM_OR_JSON_MEDIA_TYPES,
  SIGNIN_RECIPIENT_PATH,
  SIGNUP_RECIPIENT_PATH,
  signinSentMail,
} from "./email-recipient-limit.js";
import { createServerLifecycle, withTimeout } from "./lifecycle.js";
import {
  LOCALE_MODULEPRELOAD_HEADER,
  loadLocaleModulePreloads,
  resolveLocaleModulePreload,
} from "./locale-modulepreload.js";
import { mountMcpEndpoints, mountMcpOauthGuards } from "./mcp/mount.js";
import { isMcpOauthRateLimitedRequest, MCP_OAUTH_CLIENT_AUTH_PATHS } from "./mcp/oauth-routes.js";
import {
  authLimiter,
  createRateLimiterMiddleware,
  credentialBurstLimiter,
  credentialLimiter,
  readyLimiter,
  rpcLimiter,
  signinRecipientLimiter,
  signupLimiter,
  signupRecipientLimiter,
  ssrLimiter,
} from "./rate-limit.js";
import { readinessResponse, shutdownReadinessResponse, withReadinessCommit } from "./readiness.js";
import { requestLog } from "./request-log.js";
import { mountSecurityHeaders } from "./security-headers.js";
import { registerSeoRoutes } from "./seo.js";
import { sessionMiddleware } from "./session-middleware.js";
import { SIGNIN_FAILURE_PATH, signinFailureLimit } from "./signin-failure-limit.js";
import { adminBootstrapMarker, signupAvailabilityGate } from "./signup-gate.js";
import { handleSsrRequest } from "./ssr-cache.js";
import { TWO_FACTOR_OTP_PATH, twoFactorOtpLimit } from "./two-factor-otp-limit.js";

// ---------------------------------------------------------------------------
// Startup guards
// ---------------------------------------------------------------------------

// Reject wildcard CORS origin — it disables credential support and effectively
// opens the API to any website. Fail hard at startup so the misconfiguration
// is caught immediately in staging/CI, not silently in production.
if (env.CORS_ORIGIN === "*") {
  console.error(
    "[server] FATAL: CORS_ORIGIN must not be '*'. Set it to the exact origin of your frontend (e.g. https://app.example.com).",
  );
  process.exit(1);
}

// Non-production banner. NODE_ENV defaults to "development" (see
// packages/env/src/vars/shared.ts), which silently weakens several guards for
// anyone running the server by hand outside Docker — where NODE_ENV is often
// simply unset. Say so loudly at boot, naming what is weaker.
if (process.env.NODE_ENV !== "production") {
  console.warn(
    "[server] ══════════════════════════════════════════════════════════════\n" +
      `[server] NON-PRODUCTION MODE (NODE_ENV=${process.env.NODE_ENV ?? "unset → development"}) — guards weakened:\n` +
      "[server] cookies not Secure · /api-reference public · weak secrets warn-only · http:// URLs allowed\n" +
      "[server] Never expose this process publicly or use production data.\n" +
      "[server] ══════════════════════════════════════════════════════════════",
  );
}

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------

type AppVariables = {
  requestId: string;
  session: Session | null;
  /** Set only by a bearer-credential surface; none ships after CLI removal. */
  credential?: CredentialKind;
};

const app = new Hono<{ Variables: AppVariables }>();

// Secure-headers — sets a battery of security headers (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc.) on every response. The
// policy lives in mountSecurityHeaders (see its doc comment +
// security-headers.test.ts). CSP: tighten per route if third-party
// scripts/analytics are needed.
const cspConnectSrc = ["'self'", ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [])];

// CSP hash authorizing the inlined anti-FOUC theme bootstrap (THEME_INIT_SCRIPT,
// injected into <head> by apps/web/src/routes/__root.tsx). Computed from the
// shared string at startup, so it can never drift from the inlined content. An
// inline script needs a nonce or hash to run under `script-src 'self' 'nonce-…'`;
// this static bootstrap can't carry a per-request nonce, so it uses a hash.
const themeInitCspHash = `'sha256-${createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64")}'`;
mountSecurityHeaders(app, { cspConnectSrc, themeInitCspHash });

// Body-limit — reject oversized payloads early (before JSON parsing) to
// prevent memory exhaustion. 10 MB covers large form payloads; individual
// routes can override with a tighter limit if needed.
app.use(
  "/*",
  bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10 MB
    onError: (c) => c.json({ error: "Request is too large. Try sending less data." }, 413),
  }),
);

// Request-ID — attach a short random ID to every request for log correlation.
// The ID is stored in `c.var.requestId` and included in the logger output.
app.use("/*", async (c, next) => {
  const id = crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  await next();
});

// Logger — prepends the request ID for correlation. `requestLog` writes the
// path only (no query string, no credential segments, no client IP).
app.use("/*", async (c, next) => {
  const reqId = c.get("requestId") ?? "-";
  return requestLog((message) => console.log(`[${reqId}] ${message}`))(c, next);
});

const listenPort = env.SERVER_PORT ?? env.PORT ?? 3000;

// MCP server (docs/mcp.md): the OAuth discovery documents and the
// `/mcp` endpoint. Mounted before CORS and every later request-terminating
// middleware, so these paths own every method (405s, not a CORS 204 or an
// SPA page). `/mcp` is its own chain: method gate → pre-auth IP limiter →
// 1 MB body cap → credential resolution (API token or OAuth access token).
// Bearer credentials are accepted here and nowhere else.
const mcpEndpoints = mountMcpEndpoints(app, {
  auth,
  baseUrl: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  port: listenPort,
});

// Catch any uncaught error from a route/middleware so admins get a stack
// trace + request context in the logs instead of an opaque 500 in the client.
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "-";
  console.error(
    `[server] [${reqId}] Unhandled error on ${c.req.method} ${c.req.path}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  return c.json({ error: "Something didn't work on our end. Try again in a moment." }, 500);
});

// Shared oRPC error logger. Skips expected client errors (4xx ORPCErrors like
// UNAUTHORIZED / NOT_FOUND / METHOD_NOT_SUPPORTED) so logs only contain real
// problems. Transient 5xx codes (502/503/504 — usually upstream infra blipping)
// log at warn so they don't pollute error dashboards alongside genuine bugs.
function logOrpcError(error: unknown) {
  if (error instanceof ORPCError && error.status < 500) {
    return;
  }
  const isTransient5xx = error instanceof ORPCError && error.status > 500;
  const log = isTransient5xx ? console.warn : console.error;
  if (error instanceof Error) {
    log(`[orpc] ${error.name}: ${error.message}`, error.stack);
  } else {
    log("[orpc] Unknown error:", error);
  }
}
if (env.CORS_ORIGIN) {
  app.use(
    "/*",
    cors({
      origin: env.CORS_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      // Adding a header the client sets? It must go in CORS_ALLOW_HEADERS or
      // the preflight fails and the request never leaves the browser — a
      // failure mode invisible in local dev. See cors-headers.ts.
      allowHeaders: [...CORS_ALLOW_HEADERS],
      credentials: true,
    }),
  );
}

// Liveness probe — answers whether this Node process can serve HTTP. Keep this
// independent of external services so orchestrators do not restart healthy app
// containers during a transient Postgres failover.
app.get("/health", (c) => c.json({ ok: true }));

// Readiness probe — checks Postgres (the only external dependency) for deploy
// gates and manual diagnosis, and reports the job runner's coarse health.
// Rate-limited (unlike /health) because it touches Postgres on every call, so
// an unthrottled public probe is a cheap way to load the database. Fail-open:
// an orchestrator must always be able to read readiness.
//
// Its OWN bucket, not a remount of `rpcLimiter`: readiness and app traffic are
// exactly the two things that must stay independent during an incident.
const buildCommit = readBuildCommit();
const lifecycle = createServerLifecycle();
lifecycle.onShutdown(() => mcpEndpoints.close());

// The drain answer comes BEFORE the limiter, and must stay there. During a
// rolling deploy the load balancer polls readiness about once a second and the
// only correct reply is 503 "draining" — but a limiter placed first will start
// answering 429 partway through the drain window, which an orchestrator reads
// as "probe failed for an unknown reason", not as "stop sending me traffic".
// The check is a boolean read of process state: it does not touch Postgres, so
// it costs nothing to serve unthrottled and there is nothing here for a limiter
// to protect. Everything past this point does hit the database, and that is
// what `readyLimiter` still guards.
app.use("/ready", async (c, next) => {
  if (lifecycle.isShuttingDown()) {
    const { body, status } = shutdownReadinessResponse(buildCommit);
    return c.json(body, status);
  }
  await next();
});
const limitReadiness = createRateLimiterMiddleware(readyLimiter);
app.use("/ready", async (c, next) => {
  const rejected = await limitReadiness(c, next);
  if (rejected) return withReadinessCommit(rejected, buildCommit);
});
app.get("/ready", async (c) => {
  let postgres = false;
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000, "postgres readiness check");
    postgres = true;
  } catch {
    postgres = false;
  }
  const { status, body } = readinessResponse({
    postgres,
    jobs: lifecycle.jobsHealth(),
    commit: buildCommit,
  });
  return c.json(body, status);
});

// SEO / discoverability: /robots.txt, /sitemap.xml, /llms.txt. Registered here
// — before the static-asset middleware and the SSR catch-all below — so the
// `/$lang/...` router never swallows them and returns the SPA HTML shell.
registerSeoRoutes(app);

// ADMIN_EMAILS bootstrap marker (see signup-gate.ts). Pass-through by design:
// it marks member requests for admin promotion but NEVER rejects, so member
// and non-member addresses are indistinguishable at this layer.
//
// Per-address signup decisions are enforced SOLELY by the auth database hook
// (packages/auth/src/index.ts), which throws for every user creation outside
// an allowed mode. (The request-independent `signupAvailabilityGate` below
// only refuses when nobody at all may self-register.) An earlier revision additionally rejected non-members here
// with an immediate 403 while members proceeded into Better-Auth — the
// immediate-403 vs Better-Auth-processing split (shape + timing) revealed
// which emails are admins, so it was removed. SSO/JIT creation is likewise
// blocked in that hook; existing SSO users can still sign in because no user
// is created for them. Do NOT re-add an email-based early reject here.
app.use("/api/auth/sign-up/email", adminBootstrapMarker(ADMIN_EMAILS));

// Signup-specific rate limiter — stricter than the general auth limiter.
// Must be mounted BEFORE the general authLimiter so signup traffic is throttled
// at the tighter limit first.
app.use("/api/auth/sign-up/*", createRateLimiterMiddleware(signupLimiter, { failClosed: true }));

// Closed-server refusal (see signup-gate.ts): when neither open signup nor the
// ADMIN_EMAILS bootstrap is available, refuse every signup identically before
// Better-Auth can answer "already exists". Mounted after signupLimiter so it
// stays throttled; its reads are cached in-process.
app.use(
  "/api/auth/sign-up/email",
  signupAvailabilityGate(() => getSignupAvailability()),
);

// `get-session` is a benign, cookie-authenticated read that the SPA polls on
// navigation/focus — many calls per minute under normal use. It must NOT be
// subject to the strict credential-stuffing limiter below: at 10/60s with a
// 15-minute block, normal polling locks legitimate users out, and because
// sign-in/sign-up share the /api/auth/* bucket, it blocks those too (a fresh
// user hits "Too many attempts" on their very first signup). Give it the
// general RPC ceiling instead. Mounted BEFORE the strict limiter.
app.use("/api/auth/get-session", createRateLimiterMiddleware(rpcLimiter));

// Credential endpoints — the tight bucket. Sign-in and 2FA verification are
// the only routes where an attacker's guess is worth something, so they get a
// much smaller budget than the rest of the auth surface. Mounted BEFORE the
// general limiter, which still applies as a second layer.
//
// Keeping this separate is what lets the general limiter below be generous:
// these limiters key on client IP, and an office or mobile carrier shares one,
// so a single tight limit across all of /api/auth/* would lock a shared
// network out of password reset and email verification — exactly what a user
// who just failed to sign in needs next.
// TWO windows on the same routes. The 60-second bucket bounds sustained
// guessing; the 10-second one bounds a burst, which is the shape credential
// stuffing actually has — 10/60s on its own happily permits ten guesses inside
// one second. Better-Auth's built-in limiter carried a 3-per-10s rule and we
// disable it (its key degenerates to one shared bucket behind a two-hop proxy;
// see packages/auth/src/index.ts), so this is what replaces that rule rather
// than dropping it.
for (const path of ["/api/auth/sign-in/*", "/api/auth/two-factor/*"]) {
  app.use(path, createRateLimiterMiddleware(credentialBurstLimiter, { failClosed: true }));
  app.use(path, createRateLimiterMiddleware(credentialLimiter, { failClosed: true }));
}

// Two-factor OTP resends, capped per CHALLENGE. Mounted here so it runs after
// the fail-closed IP-keyed pair above — its own key is a cookie, i.e.
// caller-supplied, and must sit behind something coarser. See
// `twoFactorOtpLimiter` for why Better-Auth leaves this endpoint uncapped and
// why the key is the challenge rather than the recipient.
app.use(TWO_FACTOR_OTP_PATH, twoFactorOtpLimit());

// MCP OAuth endpoints (authorize, token, consent, register, …): body caps,
// their own buckets in place of the general limiter below (an exact raw
// method+path allowlist — a surface split, docs/development.md), and
// the authorize boundary that refuses a missing scope or foreign resource
// before Better-Auth could redirect to an unvalidated redirect_uri.
mountMcpOauthGuards(app, { baseUrl: env.BETTER_AUTH_URL });

// Rate limit the remaining auth endpoints, EXCEPT get-session (handled above)
// and the MCP OAuth allowlist (its own buckets, mounted just above).
// Must be mounted BEFORE the auth handler so every auth request is throttled.
app.use("/api/auth/*", async (c, next) => {
  if (c.req.path.endsWith("/get-session")) return next();
  if (isMcpOauthRateLimitedRequest(c)) return next();
  return createRateLimiterMiddleware(authLimiter, { failClosed: true })(c, next);
});

// Per-RECIPIENT cap on the anonymous endpoints that mail a caller-supplied
// address. Mounted AFTER the IP limiter above (which is the fail-closed
// security control) because this is the anti-abuse layer on top: the IP
// limiter bounds one caller, this bounds one mailbox, and rotating IPs defeat
// only the former. See email-recipient-limit.ts.
for (const path of EMAIL_RECIPIENT_PATHS) {
  app.use(path, emailRecipientLimit());
}
// Signup mails a caller-supplied address too, and `signupLimiter` above is
// IP-keyed — the exact control rotating IPs defeat. Its own bucket and budget:
// see signupRecipientLimiter. Mounted here, so it runs AFTER the ADMIN_EMAILS
// bootstrap marker and signupLimiter: a request rejected by those never
// reaches this limiter and so never spends a point from the recipient's
// budget. (On a fully closed server `signupAvailabilityGate` refuses first;
// otherwise signup-disabled rejections happen downstream in the auth database
// hook, so those blocked signups DO reach this limiter — same as any other
// request Better-Auth itself rejects.)
// `/sign-up/email` is the one route that widens Better-Auth's global
// JSON-only `allowedMediaTypes` to also accept form-urlencoded, so the limiter
// has to accept exactly that pair here — see FORM_OR_JSON_MEDIA_TYPES.
app.use(
  SIGNUP_RECIPIENT_PATH,
  emailRecipientLimit(signupRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES),
);
// Sign-in mails too, but only against an unverified account and only because
// `requireEmailVerification` + `sendOnSignIn` are both on — see
// SIGNIN_RECIPIENT_PATH. Mounted after the fail-closed credentialBurstLimiter /
// credentialLimiter pair above, which stays the primary control here: the
// password is checked before any mail is sent, so this bucket is a backstop
// against a leaked-credential mail loop, not an anti-spam gate.
//
// DEFERRED metering (`signinSentMail`) — this must not charge a point for every
// sign-in attempt. The bucket keys on the caller-supplied address, so a
// per-attempt charge would let anyone who knows your email 429 you out of your
// own login. See the `ConsumeWhen` doc comment.
//
// Form-urlencoded as well as JSON: `/sign-in/email` widens the global media
// types exactly as `/sign-up/email` does (`sign-in.mjs:155`), and declaring
// JSON-only here would 415 legitimate form posts before Better-Auth sees them.
app.use(
  SIGNIN_RECIPIENT_PATH,
  emailRecipientLimit(signinRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES, signinSentMail),
);

// Per-EMAIL cap on FAILED password sign-ins — the layer the IP-keyed pair
// above cannot provide: a rotating-IP stuffing campaign against ONE account
// gets a fresh 10/60s budget from every address it holds, and only this
// counter bounds it per account. Charged ONLY on 401 responses (see
// `signinFailedCredentials`), reserve-then-refund so successes never
// accumulate, 10 failures / 15 min → 10-minute block, keyed on a SHA-256 of
// the normalized email so no address ever sits in a limiter key, and fail-OPEN
// — the fail-closed IP pair stays the security floor
// on this route. Sign-in ONLY: signup/forgot-password stay IP-keyed, where a
// per-email counter would be a pure lockout lever. Full rationale:
// `signinFailureLimiter` in rate-limit.ts and signin-failure-limit.ts.
app.use(SIGNIN_FAILURE_PATH, signinFailureLimit());

// Admin gate for Better-Auth's admin plugin endpoints. The plugin role-checks
// against Cockpit Context's admin role (`packages/auth/src/admin-access.ts`: no
// impersonation, password or email resets, or session listing), but these
// routes can still set roles, ban and remove users, so they must also honor
// this app's verified-admin and forced-2FA policy before the Better-Auth
// handler sees the request.
app.use("/api/auth/admin/*", betterAuthAdminGate);

// Better-Auth's own surface is cookie-authenticated, like /rpc. Strip
// `Authorization` so no plugin — today's or a future upgrade's — can turn a
// bearer token, such as an MCP access token, into a credential for
// /api/auth/* (password change, 2FA settings…). No route
// here accepts a bearer credential (MCP bearers are accepted on /mcp only).
// The one exception is OAuth client authentication: `Authorization: Basic`
// (client_secret_basic) on the token, revoke and introspect endpoints, which
// authenticates a registered OAuth client, never a user.
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  if (!c.req.raw.headers.has("authorization")) return auth.handler(c.req.raw);
  const clientAuth = /^basic\s/i.test(c.req.raw.headers.get("authorization") ?? "");
  if (clientAuth && MCP_OAUTH_CLIENT_AUTH_PATHS.has(new URL(c.req.raw.url).pathname)) {
    return auth.handler(c.req.raw);
  }
  const headers = new Headers(c.req.raw.headers);
  headers.delete("authorization");
  return auth.handler(new Request(c.req.raw, { headers }));
});

// Resolve the Better-Auth session once per request on paths that need it.
// Mounted BEFORE the rate limiters so they can key on the user id without
// each making their own getSession() call. Not mounted on /api/auth/*
// (Better-Auth does its own lookup) or /health / SSR / dev-only routes.
app.use("/rpc/*", sessionMiddleware);

// Rate limit RPC endpoint — general API traffic (in-memory, fail-open).
app.use("/rpc/*", createRateLimiterMiddleware(rpcLimiter));
app.use("/api-reference/*", createRateLimiterMiddleware(rpcLimiter));

// In production the OpenAPI reference is admin-only: it documents every
// procedure and shouldn't be a public surface. Non-admins get a 404 (not
// 401/403) so the page isn't enumerable, matching the adminOr404 convention.
// Mounted after the rate limiter so brute-forcing the gate is throttled first.
// In development it stays open for local API exploration.
if (env.NODE_ENV === "production") {
  app.use("/api-reference/*", apiReferenceAdminGate);
}

// CSRF: /rpc ALWAYS requires the `x-csrf-token` header that the web client's
// SimpleCsrfProtectionLinkPlugin sends on every request (apps/web/src/utils/
// orpc.ts, the only /rpc caller in this repo). A cross-site form or a
// "simple" cross-origin fetch cannot set a custom header without a CORS
// preflight, and the preflight only succeeds for CORS_ORIGIN. Same-origin
// deployments used to skip the check on the theory that the browser already
// blocks such requests; requiring it everywhere removes that dependence on
// SameSite cookie behavior and on how a deployment's proxy handles CORS.
//
// The OpenAPI reference (/api-reference) keeps the old rule: its Scalar
// playground sends plain requests, and in production it is admin-gated
// (apiReferenceAdminGate above). It validates the header only on cross-origin
// deployments, where the playground is not the page's own origin.
const apiReferenceCsrfPlugins = env.CORS_ORIGIN ? [new SimpleCsrfProtectionHandlerPlugin()] : [];

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    ...apiReferenceCsrfPlugins,
  ],
  interceptors: [onError(logOrpcError)],
});

// `BatchHandlerPlugin` matches the client's `BatchLinkPlugin` (see
// `apps/web/src/utils/orpc.ts`). Without it, any time the SPA fires multiple
// concurrent queries with a shared router prefix the client wraps them into
// a single `/rpc/<prefix>/__batch__` POST that the server otherwise 404s.
//
// `maxSize` must stay in sync with the client — both read the shared
// `ORPC_BATCH_MAX_SIZE`, never a literal. If this drops below the client's
// value, the server rejects the entire batch with HTTP 413 ("Batch request
// size exceeds the maximum allowed size") and every query in it fails. That
// 413 is a *procedure count* limit, not `bodyLimit` and not a proxy payload
// limit. See `packages/config/src/orpc-batch.ts`.
export const rpcHandler = new RPCHandler(appRouter, {
  plugins: [
    new BatchHandlerPlugin({ maxSize: ORPC_BATCH_MAX_SIZE }),
    new SimpleCsrfProtectionHandlerPlugin(),
  ],
  interceptors: [onError(logOrpcError)],
});

// The oRPC dispatchers, mounted only on the paths they can answer. Building
// the context resolves the session (`createContext` falls back to
// `auth.api.getSession` wherever `sessionMiddleware` did not run), so a
// catch-all mount cost a session lookup on every static asset and SSR page.
// Hono's `/x/*` matches `/x`, `/x/` and `/x/...` — the same rule oRPC's
// `prefix` applies — so every request either handler could match still
// reaches it, after the same limiter and admin gate mounted on that pattern.
app.use("/rpc/*", async (c, next) => {
  const context = await createContext({ context: c, clientIp: resolveClientIp(c) });
  const result = await rpcHandler.handle(c.req.raw, { prefix: "/rpc", context });
  if (result.matched) return c.newResponse(result.response.body, result.response);
  await next();
});

app.use("/api-reference/*", async (c, next) => {
  const context = await createContext({ context: c, clientIp: resolveClientIp(c) });
  const result = await apiHandler.handle(c.req.raw, { prefix: "/api-reference", context });
  if (result.matched) return c.newResponse(result.response.body, result.response);
  await next();
});

if (env.NODE_ENV === "production") {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // The built web assets live at apps/web/dist — a sibling of apps/server.
  // Resolve them from THIS module's location, not the process CWD: the bundle
  // runs as /app/apps/server/dist/index.mjs with CWD=/app, so a CWD- or
  // module-relative "../web/dist" lands in the wrong place. `serveStatic`
  // (CWD-relative) and dynamic import (module-relative) disagree on the base,
  // so we hand both an absolute path computed from import.meta.url.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

  // Serve static client assets (JS, CSS, images)
  // Vite/rolldown content-hashes every file under /assets, so each URL is
  // immutable: a code change produces a new filename, never a new body at the
  // same URL. Safe to cache for a year. This middleware runs before the
  // serveStatic below (sets the header, then defers to it).
  // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
  // SSR shell — index.html and version.json must stay revalidated so new
  // deploys are picked up.
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/assets/*", serveStatic({ root: join(webDist, "client") }));

  // `build.manifest: true` (apps/web/vite.config.ts) writes the client Vite
  // manifest INTO the static root at `.vite/manifest.json`, and Hono's
  // serveStatic happily serves dotfile directories. That file maps every source
  // path to its hashed asset — including admin-only route chunks — and its
  // node_modules keys leak the exact installed version of every dependency,
  // which is free reconnaissance for anyone probing for a known CVE. The server
  // reads it from disk at startup; nothing needs it over HTTP. Deny it before
  // the catch-all static handler can find it. See locale-modulepreload.ts.
  app.all("/.vite/*", (c) => c.text("Not Found", 404));

  app.use("/*", serveStatic({ root: join(webDist, "client") }));

  // Mount TanStack Start for SSR — handles all non-static requests. The bundle
  // is produced by `apps/web` at build time and doesn't exist when this file is
  // type-checked, so the specifier is computed at runtime (a non-literal import
  // is left external by rolldown automatically).
  const startHandlerUrl = pathToFileURL(join(webDist, "server/server.js")).href;
  const { default: startHandler } = await import(startHandlerUrl);

  // Content-hashed locale aggregate chunks for SSR modulepreload. Built from
  // the client Vite manifest (apps/web `build.manifest: true`). Missing in
  // incomplete builds is non-fatal — visitors still load the locale on demand.
  loadLocaleModulePreloads(join(webDist, "client"));

  // Throttle the SSR catch-all. Everything above this line is either a static
  // file or an already-limited API route; everything reaching here renders
  // React on the server. Public pages are cached for SSR_CACHE_TTL_SECONDS,
  // but that cache is in-memory, per-replica, and keyed by URL — so a loop
  // appending a junk query string misses it every time and renders on each
  // request. Generous and fail-open on purpose: this is CPU protection, not a
  // security control, and it must never be why a real visitor can't load the
  // site. Mounted only in production, matching the SSR handler itself.
  app.use("/*", createRateLimiterMiddleware(ssrLimiter));

  app.all("/*", async (c) => {
    // Forward the per-request CSP nonce (from secureHeaders) to the SSR
    // renderer via a request header. getRouter() reads it server-side and sets
    // router.options.ssr.nonce, so TanStack Start stamps the matching nonce on
    // every inline script it injects — otherwise script-src would block them.
    //
    // Also forward the active non-default locale's aggregate chunk URL so the
    // SSR root can emit `<link rel="modulepreload">`. Both headers are
    // server-controlled: strip any client-supplied values first.
    const nonce = c.get("secureHeadersNonce");
    const headers = new Headers(c.req.raw.headers);
    headers.delete("x-csp-nonce");
    headers.delete(LOCALE_MODULEPRELOAD_HEADER);
    if (typeof nonce === "string") {
      headers.set("x-csp-nonce", nonce);
    }
    const localePreload = resolveLocaleModulePreload(new URL(c.req.raw.url).pathname);
    if (localePreload) {
      headers.set(LOCALE_MODULEPRELOAD_HEADER, localePreload);
    }
    const request = new Request(c.req.raw, { headers });
    // Public, anonymous GETs are served from a bounded in-memory HTML cache
    // (TTL via SSR_CACHE_TTL_SECONDS); everything else falls straight through
    // to the renderer. The nonce is swapped per request inside the cache.
    return handleSsrRequest({
      request,
      nonce: typeof nonce === "string" ? nonce : undefined,
      render: (req) => startHandler.fetch(req),
    });
  });
} else {
  app.get("/", (c) => {
    return c.text("OK");
  });
}

// First-admin bootstrap, see
// docs/deploy.md § First administrator: private access before public exposure
// While no account exists and ADMIN_EMAILS is set, print a one-time token the
// first signup must present. Memory only (every restart replaces it) and never
// logged again. A failed read must not stop the server: it only means no token
// this boot, and the setup card then asks for a restart.
try {
  await issueBootstrapTokenIfNeeded({
    adminEmailCount: ADMIN_EMAILS.size,
    // pagination:audited — bounded by findFirst (existence check)
    countUsers: async () => ((await prisma.user.findFirst({ select: { id: true } })) ? 1 : 0),
    log: (message) => console.log(message),
  });
} catch (err) {
  const errLabel = err instanceof Error ? err.name : "unknown error";
  console.warn(
    `[bootstrap] Could not check for existing accounts (${errLabel}); no bootstrap token this boot. Restart once the database is reachable.`,
  );
}

await lifecycle.start((onReady) =>
  serve(
    {
      fetch: app.fetch,
      port: listenPort,
      // Node's default keepAliveTimeout (5s) is shorter than the idle-reuse window of
      // fronting proxies (nginx keepalive_timeout defaults to 60-75s; Traefik similar),
      // so the app would drop sockets the proxy still considers open → sporadic 502s/
      // ECONNRESETs. The app timeout must exceed the proxy's (65s here), and Node
      // requires headersTimeout > keepAliveTimeout (66s).
      serverOptions: {
        keepAliveTimeout: 65_000,
        headersTimeout: 66_000,
      },
    },
    (info) => {
      onReady();
      console.log(`Server is running on http://localhost:${info.port}`);
    },
  ),
);
