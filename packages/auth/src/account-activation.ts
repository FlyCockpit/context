import {
  CREDENTIAL_PROVIDER_ID,
  deleteResetLinks,
  withCredentialSetupLock,
} from "./password-reset-links.js";

/**
 * Defense-in-depth tidy-up after committed activation. The adapter now deletes
 * links in the activation transaction and the reset spend rechecks eligibility
 * in its own password transaction (credential-setup-adapter.ts). These hooks
 * may retry cleanup, but never establish mailbox proof or undo passwords.
 */

/** Endpoint contexts whose user update set `emailVerified: true`. */
const verificationWrites = new WeakSet<object>();

/** `databaseHooks.user.update.before`: note a write that verifies the email. */
export function noteVerificationWrite(data: Record<string, unknown>, context: unknown): void {
  if (data.emailVerified === true && typeof context === "object" && context !== null) {
    verificationWrites.add(context);
  }
}

/**
 * `databaseHooks.user.update.after`: if this update verified the email, the
 * account is active, so its reset links go. With no endpoint context (a
 * server-side internal write) it cannot tell, so it cleans up whenever the
 * row is verified: fail safe.
 */
export async function afterUserUpdate(
  user: { id?: unknown; emailVerified?: unknown } | null | undefined,
  context: unknown,
): Promise<void> {
  if (user?.emailVerified !== true || typeof user.id !== "string") return;
  const known = typeof context === "object" && context !== null;
  if (known && !verificationWrites.has(context)) return;
  await deleteResetLinksOnActivation(user.id);
}

/**
 * `databaseHooks.account.create.after`: an IdP identity linked to the user
 * (SSO sign-in, implicit linking by verified email) makes the account active;
 * its reset links go. A credential account (an invite's own) changes nothing.
 */
export async function afterAccountCreate(
  account: { userId?: unknown; providerId?: unknown } | null | undefined,
): Promise<void> {
  if (!account || account.providerId === CREDENTIAL_PROVIDER_ID) return;
  if (typeof account.userId !== "string") return;
  await deleteResetLinksOnActivation(account.userId);
}

/** Attempts, and the pause before each retry (ms). */
const ATTEMPTS = 3;
const BACKOFF_MS = [100, 400] as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Under the credential-setup lock, delete every reset link of `userId`.
 * Idempotent, so it is retried; a final failure is logged (user id and error
 * class only) and swallowed: the leftover links are refused at redemption
 * anyway and expire on their own.
 */
export async function deleteResetLinksOnActivation(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 400);
    try {
      await withCredentialSetupLock(userId, (tx) => deleteResetLinks(tx, userId));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    `[auth] deleting reset links on account activation failed after ${ATTEMPTS} attempts; they are refused at redemption and expire on their own.`,
    {
      userId,
      error:
        lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : "unknown error",
    },
  );
}
