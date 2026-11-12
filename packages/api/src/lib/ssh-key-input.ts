import { z } from "zod";
import { createProcedureBudget } from "./procedure-budget";
import { cockpitContextRateBudget } from "./rate-budgets";
import { shortText } from "./schemas";

/**
 * One point per generate, import or one-time use: a key-pair generation or an
 * `ssh-keygen` subprocess plus an encrypted row. The default 20 per hour
 * (`COCKPIT_CONTEXT_SSH_KEY_WRITES_PER_HOUR`) is far beyond
 * setting up deploy keys by hand; fail-closed because each point spawns a
 * process (and, only when saved, writes a row).
 */
export const consumeKeyWriteBudget = createProcedureBudget({
  keyPrefix: "rl:ssh-keys-write",
  budget: () => cockpitContextRateBudget("sshKeyWrite"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many SSH key operations. Try again in ${seconds}s.`,
  unavailableMessage: "SSH key operations are temporarily unavailable. Try again in a moment.",
  unavailableLog: "[ssh-keys] write budget unavailable, failing closed:",
});

/** Shared bounds for saved imports and request-local keys. */
export const pastedSshKeySchema = z
  .object({
    privateKey: z.string().min(1).max(16_384),
    passphrase: z.string().max(4096).optional(),
    save: z.boolean().default(false),
    name: shortText.optional(),
  })
  .refine((value) => !value.save || Boolean(value.name), { path: ["name"] });
