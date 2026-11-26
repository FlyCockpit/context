/**
 * Admin action audit entries. Cockpit Context has no audit table: an entry is
 * one structured JSON line on the server log (`docker logs`, the platform's
 * log drain), written with `console.warn` so it survives an info-level filter.
 *
 * An entry names who did what to whom and when. Credential entries
 * (`recordCredentialAudit`) record a user's own security-relevant changes to
 * their credentials, in the same format with `audit: "credential"`. It never carries a secret: a
 * set-password link, token or password must not be passed in `details`.
 */
type AdminAuditAction = "users.passwordLink";

export interface AdminAuditEntry {
  action: AdminAuditAction;
  actorUserId: string;
  targetUserId: string;
  /** Non-secret facts about the action (delivery channel, expiry). */
  details?: Record<string, string | number | boolean | null>;
}

export function recordAdminAudit(entry: AdminAuditEntry, now: Date = new Date()): void {
  console.warn(
    `[audit] ${JSON.stringify({
      audit: "admin",
      action: entry.action,
      actorUserId: entry.actorUserId,
      targetUserId: entry.targetUserId,
      at: now.toISOString(),
      ...(entry.details ? { details: entry.details } : {}),
    })}`,
  );
}

type CredentialAuditAction = "mcpTokens.regenerate";

export interface CredentialAuditEntry {
  action: CredentialAuditAction;
  /** The signed-in user acting on their own credential. */
  actorUserId: string;
  /** Non-secret facts (row ids, never a token, prefix or digest). */
  details?: Record<string, string | number | boolean | null>;
}

export function recordCredentialAudit(entry: CredentialAuditEntry, now: Date = new Date()): void {
  console.warn(
    `[audit] ${JSON.stringify({
      audit: "credential",
      action: entry.action,
      actorUserId: entry.actorUserId,
      at: now.toISOString(),
      ...(entry.details ? { details: entry.details } : {}),
    })}`,
  );
}
