import {
  BOOTSTRAP_TOKEN_HEADER,
  verifyBootstrapToken,
} from "@cockpit-context/auth/bootstrap-token";
import type { SignupAvailability } from "@cockpit-context/auth/signup-availability";
import {
  runWithAllowedUserCreation,
  SIGNUP_DISABLED_MESSAGE,
  serializeSignup,
} from "@cockpit-context/auth/user-creation-policy";
import type { Context, Next } from "hono";

// ADMIN_EMAILS bootstrap marker for the email/password signup path. When the
// request carries an admin-listed address AND the one-time bootstrap token
// printed to the boot log (header `x-cockpit-bootstrap-token`, compared in
// constant time) it runs downstream inside the `admin-bootstrap` creation
// mode, which is the ONLY mode the auth database hook auto-promotes to admin
// (it never trusts SSO/JIT email claims). The hook re-verifies the token and
// admits the bootstrap only while no account exists at all.
//
// This middleware NEVER rejects: member, non-member, and malformed bodies all
// fall through to Better-Auth, which performs input validation, duplicate
// detection, and (when SIGNUP_ENABLED=false) the signup-disabled rejection
// itself in the database hook. That single-enforcement-point design is what
// keeps admin membership unobservable:
//
//   - An earlier revision rejected non-members here with an immediate 403
//     while members proceeded into Better-Auth. The immediate-403 vs
//     Better-Auth-processing split (different status/body shapes AND different
//     timing) let anyone probe which emails are admins. Any email-based early
//     reject reintroduces that oracle — including for malformed bodies, where
//     Better-Auth would otherwise return identical 400s for every address.
//   - With pass-through, every input class yields identical responses for
//     member and non-member addresses: same 400s for invalid input, same
//     generic 200 for already-registered emails, same 422 for a blocked
//     signup (both pay the password-hash cost before the hook rejects, so
//     timing is normalized too). The only divergence is a VALID new-admin
//     signup succeeding — which needs the boot-log token, so guessing a
//     listed address alone gets the same refusal as any other address.
export function adminBootstrapMarker(adminEmails: Set<string>) {
  return async function adminBootstrapMarkerMiddleware(c: Context, next: Next) {
    if (adminEmails.size === 0) return next();
    // Every signup (member, non-member, malformed) waits in the same queue, so
    // concurrent first-admin signups cannot both pass the "no admin yet" check,
    // and the queue itself reveals nothing about ADMIN_EMAILS membership.
    return serializeSignup(async () => {
      let listed = false;
      // Verified for every request (listed or not) so the check's cost does
      // not depend on allowlist membership.
      const presented = c.req.header(BOOTSTRAP_TOKEN_HEADER);
      const tokenValid = verifyBootstrapToken(presented);
      try {
        const body = (await c.req.raw.clone().json()) as { email?: unknown };
        const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
        listed = email !== null && adminEmails.has(email);
      } catch {
        // Better-Auth returns its normal validation error for malformed signup
        // bodies; the marker must not respond (or throw) for any body shape.
      }
      return listed && tokenValid
        ? runWithAllowedUserCreation("admin-bootstrap", next, { bootstrapToken: presented })
        : next();
    });
  };
}

// Request-independent early refusal for the email/password signup route. When
// NOBODY can self-register — open signup is off (env AND the admin toggle) and
// the ADMIN_EMAILS bootstrap is closed too — every request gets the same 403
// before Better-Auth runs. It never reads the submitted address, so it adds no
// membership oracle (contrast the removed email-based reject described above).
//
// Why it exists: without SMTP Better-Auth cannot use its generic duplicate
// response (that needs `requireEmailVerification`), so an existing address
// answers 422 USER_ALREADY_EXISTS while a new one answers 422
// FAILED_TO_CREATE_USER. On a closed server that would be an anonymous account
// enumeration oracle. While the bootstrap is still open the request falls
// through and the user-create hook stays the single enforcement point.
export function signupAvailabilityGate(getAvailability: () => Promise<SignupAvailability>) {
  return async function signupAvailabilityGateMiddleware(c: Context, next: Next) {
    const availability = await getAvailability();
    if (availability.signupOpen || availability.adminBootstrapOpen) return next();
    return c.json({ code: "SIGNUP_DISABLED", message: SIGNUP_DISABLED_MESSAGE }, 403);
  };
}
