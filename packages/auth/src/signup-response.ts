import { BASE_ERROR_CODES } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";

export const SIGN_UP_EMAIL_PATH = "/sign-up/email";

// The one body `/sign-up/email` answers with on success while email
// verification is required. No client reads that success body (the web form
// reads only `error` and, without SMTP, `data.token`, which is null here
// because `requireEmailVerification` never hands back a session).
const NEUTRAL_SIGN_UP_RESPONSE = { token: null, user: null } as const;

// Per-request sign-up state, keyed by the endpoint's per-request auth context:
// Better-Auth hands the same object to the before hook, the database hooks and
// the after hook of one call (pinned by signup-response.test.ts).
type SignUpRequestState = { signupOpen: boolean; created: boolean };
const requestStates = new WeakMap<object, SignUpRequestState>();

type HookContext = { context: object };
type SignUpAfterHookContext = {
  context: { returned?: unknown };
  json: (body: typeof NEUTRAL_SIGN_UP_RESPONSE) => unknown;
};
type SignUpResponseOptions = {
  emailVerificationRequired: boolean;
  isSignupOpen: () => Promise<boolean>;
};

/**
 * Before-hook half: snapshot whether sign-up is open, once, at the start of
 * every sign-up, whatever the address. The after hook then decides without any
 * read of its own, so a free and a registered address cost the same here (a
 * read after `createUser` would miss the cache the creation just invalidated,
 * and only a free address would pay it).
 */
export async function snapshotSignUpRequest(ctx: HookContext, opts: SignUpResponseOptions) {
  if (!opts.emailVerificationRequired) return;
  requestStates.set(ctx.context, { signupOpen: await opts.isSignupOpen(), created: false });
}

/**
 * Sign-up availability for the user.create database hook: the request-start
 * snapshot when this is a sign-up, else `read()` (SSO/JIT, admin invites).
 * The creation decision and the response normalization then agree even if an
 * admin toggles sign-up mid-request: otherwise a free address could get 422
 * while a registered one still got the snapshot's 200.
 */
export function signupOpenForRequest(
  ctx: { context?: object } | null | undefined,
  read: () => Promise<boolean>,
): Promise<boolean> {
  const state = ctx?.context ? requestStates.get(ctx.context) : undefined;
  return state ? Promise.resolve(state.signupOpen) : read();
}

/** user.create.after: a user row really exists for this sign-up request. */
export function markSignUpCreatedUser(ctx: HookContext | null | undefined) {
  const state = ctx ? requestStates.get(ctx.context) : undefined;
  if (state) state.created = true;
}

/**
 * After-hook for `/sign-up/email` that makes the response independent of
 * whether the address already has an account.
 *
 * With `requireEmailVerification`, Better-Auth answers a sign-up for a
 * registered address with a synthetic "pretend it worked" user. That user is
 * built without plugin defaults (the admin plugin's `role` is null instead of
 * "user"), so its body tells a registered address from a free one. Any future
 * plugin field would reopen that, so every success body becomes one fixed
 * shape instead of patching the synthetic user.
 *
 * Better-Auth also returns that synthetic 200 *before* `createUser`, so while
 * sign-up is closed the database hook's rejection (422 FAILED_TO_CREATE_USER)
 * only ever reaches free addresses. The server's `signupAvailabilityGate`
 * already refuses every sign-up once an account exists and sign-up is closed;
 * as the second line, a 200 stands while sign-up is closed only if this
 * request really created the user (the `ADMIN_EMAILS` bootstrap). A missing
 * snapshot fails closed.
 *
 * Without SMTP there is no verification step: a new address is signed in and
 * a registered one gets 422 USER_ALREADY_EXISTS from Better-Auth. That is
 * inherent to unverified open sign-up (the server warns about it at boot), so
 * both hooks leave that mode alone.
 *
 * Error responses are left alone: they are already address-independent.
 */
export function neutralizeSignUpResponse(
  ctx: SignUpAfterHookContext,
  opts: Pick<SignUpResponseOptions, "emailVerificationRequired">,
) {
  if (!opts.emailVerificationRequired) return;
  if (isAPIError(ctx.context.returned)) return;
  const state = requestStates.get(ctx.context);
  if (!state?.created && !state?.signupOpen) {
    throw APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_CREATE_USER);
  }
  return ctx.json(NEUTRAL_SIGN_UP_RESPONSE);
}
