import { runSeed } from "@cockpit-context/db/seed";
import { env } from "@cockpit-context/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { adminOr404Procedure } from "../index";

/** Development-only confirmation; production never runs the seed. */
export function requiredConfirmPhrase(_nodeEnv?: string): string {
  return "seed";
}

let seedRunning = false;

export const seedRouter = {
  /**
   * Drives the admin page: which confirm phrase to require and whether to
   * hide this development surface in production. Admin-gated.
   */
  info: adminOr404Procedure.handler(() => {
    const isProduction = env.NODE_ENV === "production";
    return {
      isProduction,
      requiredConfirmPhrase: requiredConfirmPhrase(env.NODE_ENV),
    };
  }),

  /**
   * Run the seed inline, inside this request, and return its summary.
   *
   * Inline rather than a background job because a seed is required to be short
   * and idempotent (packages/db/prisma/seed.ts) and the operator wants its
   * summary right away. The request blocks while it runs and cannot be
   * cancelled mid-write; a seed that grows past a few seconds should become a
   * job on the Postgres job table instead (docs/development.md).
   *
   * One run at a time per process: a second press while a seed is running gets
   * CONFLICT instead of a rival run. Cockpit Context runs one app replica, so the
   * process-local guard is the whole guard (docs/hosting.md).
   */
  run: adminOr404Procedure
    .input(z.object({ confirm: z.string() }))
    .handler(async ({ input, context }) => {
      if (env.NODE_ENV === "production") return { summary: [], durationMs: 0 };
      const expected = requiredConfirmPhrase();
      if (input.confirm.trim() !== expected) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Confirmation phrase does not match. Type "${expected}" exactly to run the seed.`,
        });
      }
      if (seedRunning) {
        throw new ORPCError("CONFLICT", {
          message: "A seed is already running. Wait for it to finish, then try again.",
        });
      }
      seedRunning = true;
      const started = Date.now();
      try {
        console.log(`[seed] Run requested by ${context.session.user.id}`);
        // The demo data belongs to the admin who pressed the button: only a
        // conversation's owner can read it (docs/access-matrix.md).
        const result = await runSeed({ ownerId: context.session.user.id });
        const durationMs = Date.now() - started;
        console.log(`[seed] Finished in ${durationMs}ms — ${result.summary.length} step(s)`);
        return { summary: result.summary, durationMs };
      } finally {
        seedRunning = false;
      }
    }),
};
