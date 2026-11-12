import { createHash } from "node:crypto";
import { cockpitContextRateBudget, type RateBudget } from "@cockpit-context/api/lib/rate-budgets";
import {
  authRateFamily,
  emailRateFamily,
  rpcRateFamily,
  type ScaledMember,
} from "@cockpit-context/api/lib/rate-limit-families";
import type { Session } from "@cockpit-context/auth";
import type { Context, Next } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";

type RateLimiter = Pick<RateLimiterMemory, "consume" | "points">;

// ---------------------------------------------------------------------------
// Rate limiters — in-memory, one process
// ---------------------------------------------------------------------------
// Algorithm: "enhanced fixed window" (rate-limiter-flexible's default).
// This is NOT a true sliding window — it counts hits per fixed-duration bucket
// with partial-overlap weighting. Good enough for abuse prevention; don't
// replace it thinking the name is wrong.
//
// Store: `RateLimiterMemory`. Cockpit Context's supported topology is exactly ONE app
// container plus Postgres (docs/hosting.md), so these process-local
// buckets protect that one server process. Running a second app replica is
// unsupported while the limiters live in memory: every budget here, including
// the per-account sign-in bucket, would silently multiply by the replica
// count. Introduce a shared store before supporting horizontal scaling.
// Counters also reset when the process restarts; that is accepted (a restart
// is rare and visible, and the windows are minutes to an hour).
//
// Fail mode: kept as an explicit contract on the
// middleware, even though an in-memory limiter has no outage to fail on.
//   • The strict auth-facing limiters are mounted with `{ failClosed: true }`:
//     if `consume` ever throws something other than a rejection, the request
//     gets a 503 rather than passing unthrottled.
//   • General limiters (rpc/ready/ssr) and the anti-abuse layers fail open.
// ---------------------------------------------------------------------------

// How long (seconds) to tell clients to wait after a fail-closed 503. There is
// no per-key `msBeforeNext` to report when the limiter itself failed, so a
// small fixed backoff is the honest answer.
const FAIL_CLOSED_RETRY_AFTER_SECONDS = 5;

// ---------------------------------------------------------------------------
// Per-EMAIL failed-sign-in ceiling — tunables for `signinFailureLimiter` below.
// ---------------------------------------------------------------------------
// Deliberately NOT env vars. The numbers are chosen as a matched triple whose
// shortness IS the anti-lever property (see that limiter's doc comment), and
// the layer is fail-open anti-abuse on top of the fail-closed IP-keyed pair,
// not a security control an operator needs to retune per deployment. Changing
// them is a code review, not a knob turn.
export const SIGNIN_FAILURE_POINTS = 10; // failed sign-ins per email …
export const SIGNIN_FAILURE_WINDOW_SECONDS = 15 * 60; // … within this window …
export const SIGNIN_FAILURE_BLOCK_SECONDS = 10 * 60; // … then block that email this long.

// ---------------------------------------------------------------------------
// Family members — each limiter's designed budget, resolved against its
// family's env budget (RATE_LIMIT_<FAMILY>_*). The literals are the code
// defaults; with no env set every multiplier is exactly 1.
// ---------------------------------------------------------------------------
const credentialBudget = authRateFamily({ points: 10, windowSeconds: 60, blockSeconds: 300 });
const credentialBurstBudget = authRateFamily({ points: 3, windowSeconds: 10 });
const authBudget = authRateFamily({ points: 30, windowSeconds: 60, blockSeconds: 300 });
const signupBudget = authRateFamily({ points: 10, windowSeconds: 3600, blockSeconds: 900 });
const twoFactorOtpBudget = authRateFamily({ points: 3, windowSeconds: 900 });
const emailRecipientBudget = emailRateFamily({ points: 3, windowSeconds: 3600, blockSeconds: 0 });
const signupRecipientBudget = emailRateFamily({ points: 6, windowSeconds: 3600, blockSeconds: 0 });
const signinRecipientBudget = emailRateFamily({ points: 10, windowSeconds: 3600, blockSeconds: 0 });
const rpcBudget = rpcRateFamily({ points: 100, windowSeconds: 60 });
const readyBudget = rpcRateFamily({ points: 60, windowSeconds: 60 });
const ssrBudget = rpcRateFamily({ points: 300, windowSeconds: 60 });

// Cockpit Context's MCP surfaces are not family members: each has its own count variable
// (`COCKPIT_CONTEXT_MCP_*_PER_*`, packages/env/src/rate-budgets.ts),
// read through the one budget reader. No block on any of them.
const mcpIpBudget = cockpitContextRateBudget("mcpIp");
const mcpIdentityBudget = cockpitContextRateBudget("mcpCredential");
const mcpOauthBudget = cockpitContextRateBudget("mcpOauth");
const mcpConsentBudget = cockpitContextRateBudget("mcpConsent");
const mcpRegistrationBudget = cockpitContextRateBudget("mcpRegistration");

/**
 * Credential limiter — the credential-stuffing defense. Applied ONLY to the
 * endpoints where a guess is worth something: sign-in and 2FA verification.
 *
 * 10 requests / 60 s per key, 5-minute block.
 *
 * Why this is separate from `authLimiter`: these limiters key on client IP,
 * and offices, schools, campus wifi, and mobile carriers put many humans
 * behind one address. A single tight limit across all of `/api/auth/*` had to
 * be either loose enough to be a weak credential defense or tight enough to
 * lock a shared office out of *password reset and email verification* — the
 * two things a locked-out user needs most. Splitting the surface lets the
 * credential endpoints stay tight while the recovery endpoints stay usable.
 *
 * Scales with the AUTH budget (`RATE_LIMIT_AUTH_*`) at its designed ratio to
 * the family reference (10/30) — see the family doc in
 * `packages/api/src/lib/rate-limit-families.ts`.
 *
 * Mounted fail-closed, same rationale as `authLimiter`.
 */
export const credentialLimiter = new RateLimiterMemory({
  keyPrefix: "rl:cred",
  points: credentialBudget.points,
  duration: credentialBudget.durationSeconds,
  blockDuration: credentialBudget.blockSeconds,
});

/**
 * Credential BURST limiter — short-window companion to `credentialLimiter`,
 * mounted on the same routes.
 *
 * 3 requests / 10 s per key, no block: the window is short enough that a block
 * would only add confusion.
 *
 * Why both: Better-Auth ships its own limiter with a 3-sign-ins-per-10-seconds
 * rule, and we disable it (see packages/auth/src/index.ts — its default key
 * degenerates to a single shared bucket behind a two-hop proxy, which is both
 * an outage and no defense). Disabling it is right, but the 60-second bucket
 * alone does not reproduce what it was doing: 10/60s permits a 10-guess burst
 * in one second, which is the shape credential stuffing actually has. This
 * restores the burst ceiling on top of a correctly-keyed counter.
 *
 * Mounted fail-closed, same rationale as `authLimiter`.
 */
export const credentialBurstLimiter = new RateLimiterMemory({
  keyPrefix: "rl:cred-burst",
  points: credentialBurstBudget.points,
  duration: credentialBurstBudget.durationSeconds,
});

/**
 * Sign-in FAILURE limiter — the per-ACCOUNT half of the credential defense.
 * Enforced by `signin-failure-limit.ts`; everything behavioral (why only 401s
 * charge, why the charge is reserved then refunded) is documented there and in
 * its tests.
 *
 * `credentialLimiter`/`credentialBurstLimiter` key on client IP, which is the
 * right default but is exactly the control a rotating-IP stuffing campaign
 * defeats: a botnet with N source addresses gets N × 10 guesses per minute at
 * the ONE account it is working on, bounded after that only by
 * `minPasswordLength` and 2FA. This bucket counts FAILED sign-in attempts per
 * EMAIL, so the ceiling follows the account under attack rather than the
 * address the attack comes from. It applies ONLY to
 * `POST /api/auth/sign-in/email` — never to signup or password reset, which
 * stay IP-keyed (they cannot fail a credential check, so there is nothing to
 * count, and a per-email counter on them is pure lockout lever).
 *
 * Why this does not recreate the hazard that keeps `emailRecipientLimiter`'s
 * blockDuration at 0 (see its doc comment). That hazard is about buckets
 * charged per ATTEMPT: four anonymous POSTs naming a victim would deny them a
 * password reset at no skill and no cost, because naming the address IS the
 * request. This bucket is charged per FAILED CREDENTIAL VERIFICATION — a point
 * lands only when Better-Auth actually ran the password check and it did not
 * match, and successful sign-ins are refunded. An attacker who knows only the
 * address can still fill it by submitting wrong passwords; that is inherent to
 * any per-account failure counter. The residual lever is what the numbers are
 * for: at 10 failures / 15 min → 10-minute block, the worst a campaign can do
 * is blip a victim's login for ten minutes at a time, while the campaign
 * itself is capped at 10 password checks per 15 minutes per email no matter
 * how many IPs it holds. Do not lengthen either window without re-reading this
 * paragraph. rate-limiter-flexible applies the block TTL on the first overshoot
 * only, so retrying while blocked does not extend the sentence.
 *
 * Keys are `signinFailureKey(email)` — a SHA-256 of the normalized address,
 * never the raw email — hashed so a reusable, correlatable identifier never
 * sits in limiter state (or a heap dump of it) for the life of the window.
 *
 * Fail-OPEN, like the general surfaces — unlike the IP-keyed credential pair
 * this sits behind. Those fail closed because losing them silently reopens
 * the stuffing hole; this layer is enforced ON TOP of a pair that is still
 * fail-closed on the very same route, so a limiter fault degrades sign-in to
 * exactly the pre-this-limiter posture rather than to nothing. Failing closed
 * here would instead 503 one account's sign-in because a counter about it
 * could not be read — the lockout lever again.
 */
export const signinFailureLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signin-fail",
  points: SIGNIN_FAILURE_POINTS,
  duration: SIGNIN_FAILURE_WINDOW_SECONDS,
  blockDuration: SIGNIN_FAILURE_BLOCK_SECONDS,
});

/**
 * Rate-limit key for `signinFailureLimiter`: SHA-256 of the normalized
 * (lowercased + trimmed) address, base64url-encoded.
 *
 * Normalization uses `emailRateLimitKey`, so case and stray whitespace cannot
 * mint fresh buckets — `A@x.com` and ` a@X.com ` attack the same account and
 * must share its failure budget. Hashing keeps the address itself out of
 * limiter keys and any log line that echoes them. Deliberately NOT doing
 * provider-specific canonicalization (Gmail dots, `+tag`): collapsing those
 * would let one abusive mailbox spend a different user's budget, same
 * reasoning as `emailRateLimitKey`.
 */
export function signinFailureKey(email: string): string {
  return `em:${createHash("sha256").update(emailRateLimitKey(email)).digest("base64url")}`;
}

/**
 * Auth limiter — the general `/api/auth/*` ceiling for everything that is not
 * a credential endpoint (those get `credentialLimiter`) and not signup (that
 * gets `signupLimiter`). Password reset, email verification, session ops.
 *
 * 30 requests / 60 s per key, 5-minute block. Sized for shared NAT: a 2FA
 * sign-in is 4-5 requests, so this has to clear several concurrent humans.
 *
 * Mounted fail-closed (`createRateLimiterMiddleware(..., { failClosed: true })`):
 * if the limiter ever faults, the auth surface 503s rather than letting
 * credential-stuffing traffic through unthrottled.
 */
export const authLimiter = new RateLimiterMemory({
  keyPrefix: "rl:auth",
  points: authBudget.points,
  duration: authBudget.durationSeconds,
  blockDuration: authBudget.blockSeconds,
});

/**
 * Signup limiter — applied to /api/auth/sign-up/* to prevent account-creation
 * spam. 10 requests / 3600 s per key with a 15-minute block.
 *
 * Deliberately not tighter: this limiter keys on IP, which is exactly the
 * control a rotating-IP attacker defeats, so squeezing it buys little while
 * costing a shared-NAT office its ability to sign up at all. The control that
 * actually bounds signup abuse is `signupRecipientLimiter` below, which keys
 * on the address being mailed.
 *
 * Must be mounted BEFORE the general authLimiter so signup traffic hits this
 * tighter limit first; the authLimiter still applies as a second layer.
 *
 * Mounted fail-closed, same rationale as `authLimiter`: a limiter fault 503s
 * rather than opening the door to signup spam.
 */
export const signupLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signup",
  points: signupBudget.points,
  duration: signupBudget.durationSeconds,
  blockDuration: signupBudget.blockSeconds,
});

/**
 * Email-recipient limiter — caps how much mail a single ADDRESS can be sent
 * from the anonymous endpoints that accept a recipient in the request body
 * (`/api/auth/send-verification-email`, `/api/auth/request-password-reset`).
 * Signup mails one too and gets its own bucket — see `signupRecipientLimiter`.
 *
 * Every other limiter here keys on client IP (or user id). That bounds how fast
 * one caller can hit an endpoint; it does not bound how much mail one mailbox
 * receives. An attacker with rotating IPs — a botnet, a proxy pool, or plain
 * IPv6 — multiplies `RATE_LIMIT_AUTH_POINTS` by the number of source addresses
 * they can reach, and every one of those requests lands in the same victim's
 * inbox. The victim cannot opt out, and the mail genuinely comes from you, so
 * the cost is sender reputation as much as nuisance.
 *
 * Keyed on the normalized recipient (lowercased + trimmed) so case and stray
 * whitespace can't mint fresh buckets. `RATE_LIMIT_EMAIL_POINTS=0` disables
 * the whole recipient family (all three buckets below).
 *
 * `blockDuration` is **0**, unlike the IP-keyed limiters. Keying on an
 * attacker-supplied identifier cuts both ways: it stops a flood aimed at a
 * mailbox, but it also hands an anonymous caller a lever on someone else's
 * account. With a non-zero block, four unauthenticated POSTs to
 * `/request-password-reset` would deny that user a reset for the whole block
 * window, and each retry would extend it. At 0 the fixed window still caps
 * throughput while suppression expires with the window itself. Raise it only
 * if you accept that trade — and note it is a code change now, deliberately:
 * the block stays 0 unless someone re-reads this paragraph.
 *
 * Scales with the EMAIL budget (`RATE_LIMIT_EMAIL_*`) — this bucket IS the
 * family reference (3/hour).
 *
 * Fail-OPEN, unlike `authLimiter`/`signupLimiter`. Those fail closed because
 * losing them exposes credential stuffing and signup spam — a real security
 * regression. This one is anti-abuse on top of an IP limiter that is still
 * enforced (fail-closed) on the very same routes, so a fault here never
 * leaves these endpoints unthrottled. Failing closed here would instead lock
 * every user out of their own password reset, which is the worse trade.
 */
export const emailRecipientLimiter = new RateLimiterMemory({
  keyPrefix: "rl:email-to",
  points: emailRecipientBudget.points,
  duration: emailRecipientBudget.durationSeconds,
  blockDuration: emailRecipientBudget.blockSeconds,
});

/**
 * Same idea as `emailRecipientLimiter`, for `/api/auth/sign-up/email`.
 *
 * Signup mails a caller-supplied address too (`sendOnSignUp: true`), so it is
 * the same mail cannon as the resend endpoints — but its only ceiling was
 * `signupLimiter`, which is IP-keyed and therefore defeated by exactly the
 * rotating-IP attack this file's other doc comment describes. An existing
 * address 422s before mail is sent, so the reachable target is *unregistered*
 * addresses; each request also creates a real `User` row, making this a row
 * flood as well as a mail flood.
 *
 * Separate bucket, not the shared one: signup is a different act from "re-send
 * my link", and folding them together would let a signup attempt eat the
 * budget a legitimate user needs to recover their own account (or vice versa).
 * A separate, higher budget also keeps shared-NAT offices working.
 */
export const signupRecipientLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signup-to",
  points: signupRecipientBudget.points,
  duration: signupRecipientBudget.durationSeconds,
  blockDuration: signupRecipientBudget.blockSeconds,
});

/**
 * Same idea again, for `/api/auth/sign-in/email`.
 *
 * Sign-in is not obviously a mailer, which is exactly why it was missed:
 * `requireEmailVerification: true` plus `sendOnSignIn: true` (both in
 * `packages/auth/src/index.ts`) means a sign-in attempt against an *unverified*
 * account re-sends the verification link instead of returning a session. That
 * makes `/sign-in/email` the third anonymous endpoint that mails an address
 * taken from the request body.
 *
 * Weaker than the other two by construction: Better-Auth validates the password
 * before mailing, so an attacker cannot aim this at an arbitrary mailbox — only
 * at one whose credentials they already hold. That is why the budget is the most
 * generous of the three and why `credentialLimiter` remains the real control
 * here. What this bucket stops is the leaked-credential mail loop: a stuffing
 * run that happens to hold a valid password for an unverified account would
 * otherwise mail that address once per attempt, from as many IPs as it likes.
 *
 * Separate bucket, per the one-bucket-per-surface rule: folding sign-in into the
 * shared `rl:email-to` budget would let sign-in traffic consume the points a user
 * needs for their own password reset.
 *
 * Charged in DEFERRED mode (`signinSentMail`), so a point is spent only when the
 * response says mail actually went out. Read the `ConsumeWhen` doc comment in
 * `email-recipient-limit.ts` before changing that: on a bucket keyed by a
 * caller-supplied address, charging every attempt turns this limiter into an
 * unauthenticated lockout lever aimed at the login page itself — a worse bug
 * than the unmetered mailer it exists to bound. Verified users' sign-ins leave no
 * LASTING charge: the point is refunded as the response goes out. They can still
 * occupy the bucket for as long as they are in flight, so a sustained flood of
 * concurrent sign-in attempts against one address can transiently 429 that
 * address; see `ConsumeWhen` for why that window is accepted rather than traded
 * away. "No lasting charge" is the claim; "cannot be affected at all" is not.
 */
export const signinRecipientLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signin-to",
  points: signinRecipientBudget.points,
  duration: signinRecipientBudget.durationSeconds,
  blockDuration: signinRecipientBudget.blockSeconds,
});

/**
 * Two-factor OTP limiter — caps resends per two-factor CHALLENGE.
 *
 * `/api/auth/two-factor/send-otp` is the fourth recipient-controlled mailer, and
 * the cheapest one to abuse. Better-Auth's handler calls `verifyTwoFactor(ctx)`,
 * mints a code, and mails it — with **no per-challenge cap of any kind**
 * (`two-factor/otp/index.mjs:67-91`). The challenge cookie is only consumed on a
 * *successful* verification, so a single signed cookie can be replayed
 * indefinitely, and every replay puts another mail in the owner's inbox.
 *
 * That makes it cheaper than the sign-in mailer this file's other comment
 * describes: sign-in costs a full password verification per mail, this costs one
 * replayed cookie. The only ceiling today is the IP-keyed credential pair, which
 * is exactly what rotating IPs defeat.
 *
 * Keyed on the CHALLENGE, not the recipient, and that choice is what makes this
 * safe as well as effective:
 *
 *   - It bounds precisely the cheap part. Exceeding the budget forces the caller
 *     to mint a fresh challenge, which costs a real password sign-in — bounded
 *     per IP by `credentialBurstLimiter`/`credentialLimiter` and, for the mail
 *     itself, by `signinRecipientLimiter`.
 *   - It cannot be turned against a user. A recipient-keyed bucket here would
 *     let anyone who knows an address exhaust it and deny that user their own
 *     second factor — locking them out of login entirely. Each challenge is its
 *     own bucket, so an attacker's replays can only exhaust the attacker's.
 *
 * The key is caller-supplied (a cookie), so per the one-bucket-per-surface rule
 * it must sit behind something coarser: it is mounted after the fail-closed
 * IP-keyed credential limiters on `/api/auth/two-factor/*`.
 *
 * Scales with the AUTH budget, not the EMAIL one: it is not recipient-keyed
 * (each challenge is its own bucket), and it lives on the credential surface
 * the AUTH family guards.
 */
export const twoFactorOtpLimiter = new RateLimiterMemory({
  keyPrefix: "rl:2fa-otp",
  points: twoFactorOtpBudget.points,
  duration: twoFactorOtpBudget.durationSeconds,
});

/**
 * Normalize a recipient into a rate-limit key.
 *
 * Lowercase + trim only. Deliberately NOT doing provider-specific
 * canonicalization (stripping Gmail dots or `+tag` suffixes): those rules
 * differ per provider, and collapsing `a+work@x.com` into `a@x.com` would let
 * one abusive address consume a different user's budget.
 */
export function emailRateLimitKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Build a general-surface limiter (in-memory, mounted fail-open).
 *
 * Each surface's budget is a family member resolved from that family's env
 * budget (`RATE_LIMIT_<FAMILY>_*`) — see the members block above. Setting a
 * family's POINTS/WINDOW_SECONDS re-tunes every member of that family
 * coherently; the per-member ratios stay fixed in code.
 *
 * **Give each surface its own limiter, not a shared one.** Every limiter built
 * here gets a distinct `keyPrefix`, which is what makes its budget independent.
 * Mounting one limiter object on several unrelated routes silently merges them
 * into a single bucket: this template once shipped `rpcLimiter` on /rpc and its
 * media routes, so one busy surface burned the entire API budget for the whole
 * minute.
 */
function createSurfaceLimiter(name: string, member: ScaledMember | RateBudget): RateLimiterMemory {
  return new RateLimiterMemory({
    keyPrefix: `rl:${name}`,
    points: member.points,
    duration: member.durationSeconds,
  });
}

/**
 * RPC limiter — applied to /rpc/*, /api-reference/* and
 * /api/auth/get-session for normal API traffic. 100 requests / 60 s per key.
 *
 * That list is exhaustive. If you mount this on a fourth route, update this
 * line — a stale docstring here is how the shared-bucket bug got missed the
 * first time. In general, mount a NEW limiter rather than reusing this one:
 * see `createSurfaceLimiter` above for why.
 *
 * One request here can carry up to `ORPC_BATCH_MAX_SIZE` procedures via the
 * oRPC batch plugin, so the effective procedure ceiling is ~10× this number.
 * That is intended — batching exists to reduce round trips — but keep it in
 * mind before lowering this budget.
 */
export const rpcLimiter = createSurfaceLimiter("rpc", rpcBudget);

/**
 * Readiness limiter — /ready.
 *
 * `/ready` touches Postgres on every call, so an unthrottled public probe is a
 * cheap way to load the database. It gets its own bucket rather
 * than sharing the RPC one for a reason specific to this route: an orchestrator
 * must be able to read readiness even while a client on the same egress IP is
 * saturating the API, and conversely a health-check loop must not eat into the
 * SPA's budget. Sharing would couple exactly the two things that need to stay
 * independent during an incident.
 *
 * Mounted fail-open — a deploy gate that cannot read readiness is worse than
 * an unthrottled probe.
 */
export const readyLimiter = createSurfaceLimiter("ready", readyBudget);

/**
 * SSR limiter — the server-rendered catch-all.
 *
 * Public pages are cached for `SSR_CACHE_TTL_SECONDS`, but that cache is
 * in-memory, per-replica, and keyed by URL — so a loop appending a junk query
 * string misses it every time and renders React on each request. Generous and
 * fail-open: this is CPU protection, not a security control, and it must never
 * be the reason a real visitor cannot load the marketing site.
 */
export const ssrLimiter = createSurfaceLimiter("ssr", ssrBudget);

// ---------------------------------------------------------------------------
// MCP surfaces (docs/mcp.md; ported from ws-model-proxy). Mounted by
// apps/server/src/mcp/mount.ts. Every number below is a default, set by its
// own `COCKPIT_CONTEXT_MCP_*_PER_*` variable. The per-credential tool-call and query
// budgets live beside the tools in apps/server/src/mcp/tools.ts.
// ---------------------------------------------------------------------------

/**
 * `/mcp` before authentication, keyed by client IP only — never by the
 * presented token: a caller who chooses the token would choose the bucket.
 * 120 / 60 s (`COCKPIT_CONTEXT_MCP_IP_REQUESTS_PER_MINUTE`). Fail-closed (the surface
 * spends model budget).
 */
export const mcpIpLimiter = createSurfaceLimiter("mcp-ip", mcpIpBudget);

/**
 * `/mcp` after authentication, one bucket per verified credential (API
 * token or OAuth grant): bounds one connection rotating IPs. 240 / 60 s of
 * protocol traffic (initialize, tools/list, calls;
 * `COCKPIT_CONTEXT_MCP_CREDENTIAL_REQUESTS_PER_MINUTE`). Fail-closed.
 */
export const mcpIdentityLimiter = createSurfaceLimiter("mcp-identity", mcpIdentityBudget);

/**
 * The MCP OAuth protocol endpoints (authorize, token, revoke, public-client,
 * prelogin, JWKS), keyed by client IP: 120 / 60 s
 * (`COCKPIT_CONTEXT_MCP_OAUTH_REQUESTS_PER_MINUTE`) with no block, so a client
 * refreshing tokens never locks its network out of the flow. These routes are
 * exempt from `authLimiter` (their own bucket instead — a surface split, see
 * docs/development.md).
 */
export const mcpOauthLimiter = createSurfaceLimiter("mcp-oauth", mcpOauthBudget);

/**
 * Consent and continue submissions, keyed by the signed-in user (IP
 * fallback): 30 / 60 s (`COCKPIT_CONTEXT_MCP_CONSENTS_PER_MINUTE`).
 */
export const mcpConsentLimiter = createSurfaceLimiter("mcp-consent", mcpConsentBudget);

/**
 * Unauthenticated dynamic client registration persists a client row per
 * request, so it is one whole-service bucket (rotating IPs cannot multiply
 * it): 60 / hour (`COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR`).
 */
export const mcpRegistrationLimiter = createSurfaceLimiter(
  "mcp-registration",
  mcpRegistrationBudget,
);

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Resolve the rate-limit key for a request.
 *
 * Priority:
 * 1. Authenticated user → session.user.id (so limits follow the account, not the IP)
 * 2. Anonymous → the real client IP (`resolveClientIp`, proxy-aware) → "unknown"
 *
 * The session is resolved once per request by `sessionMiddleware` and read
 * here from the Hono context. Routes that don't mount `sessionMiddleware`
 * (or the rate-limit unit test) leave `c.get("session")` undefined; we fall
 * through to IP keying in that case.
 */
function resolveKey(c: Context): string {
  const existing = c.get("session") as Session | null | undefined;
  if (existing?.user?.id) {
    return `uid:${existing.user.id}`;
  }

  return resolveClientIp(c);
}

/**
 * Stamp `X-RateLimit-Limit/-Remaining/-Reset` from a limiter result.
 *
 * Takes only `points` off the limiter — deliberately looser than the
 * `RateLimiter` type so middleware that enforces a hand-shaped limiter
 * (`signin-failure-limit.ts`, tests) can share the exact header shape and
 * response contract of `createRateLimiterMiddleware` without casting.
 */
export function setRateLimitHeaders(
  c: Context,
  limiter: { readonly points: number },
  res: RateLimiterRes,
) {
  const limit = limiter.points;
  const remaining = Math.max(0, res.remainingPoints);
  // msBeforeNext is ms until the current window resets
  const resetEpochSeconds = Math.ceil((Date.now() + res.msBeforeNext) / 1000);

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(resetEpochSeconds));
}

/**
 * Create a Hono middleware that enforces a `rate-limiter-flexible` limiter.
 *
 * On rejection → 429 JSON with rate-limit + Retry-After headers.
 * On any other limiter error (not expected from `RateLimiterMemory`, but the
 * contract is explicit):
 *   • `failClosed: false` (default) → request passes through (fail-open).
 *   • `failClosed: true` → reject with 503 + Retry-After. Use for the strict
 *     auth/signup limiters, so their protection can never silently vanish.
 *
 * `resolveKey` overrides how the bucket is chosen. Default is user id when a
 * session is on the context, else client IP. Pass an override only when a
 * route cannot use `sessionMiddleware`.
 */
export function createRateLimiterMiddleware(
  limiter: RateLimiter,
  options?: { failClosed?: boolean; resolveKey?: (c: Context) => string },
) {
  const failClosed = options?.failClosed ?? false;
  const keyFor = options?.resolveKey ?? resolveKey;
  return async (c: Context, next: Next) => {
    const key = keyFor(c);

    try {
      const res = await limiter.consume(key);
      setRateLimitHeaders(c, limiter, res);
      await next();
    } catch (rlResult: unknown) {
      if (rlResult instanceof RateLimiterRes) {
        // Rate limit exceeded — reject with 429
        setRateLimitHeaders(c, limiter, rlResult);
        const retryAfter = Math.ceil(rlResult.msBeforeNext / 1000);
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }

      // Any other error means the limiter itself threw unexpectedly.
      if (failClosed) {
        // Fail-closed: refuse the request. Better to 503 the auth surface than
        // to let credential-stuffing / signup-spam through unthrottled.
        console.error("[rate-limit] Limiter error, failing closed:", rlResult);
        c.header("Retry-After", String(FAIL_CLOSED_RETRY_AFTER_SECONDS));
        return c.json(
          { error: "Service temporarily unavailable. Please try again in a moment." },
          503,
        );
      }

      // Fail-open: log and let the request through so a limiter fault doesn't
      // take down the entire API.
      console.error("[rate-limit] Limiter error, failing open:", rlResult);
      await next();
    }
  };
}
