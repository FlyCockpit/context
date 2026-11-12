/**
 * Keeps this process's row in the scheduled-deletion instance registry
 * (`_cockpit_context_instance`, created by scripts/db/lib/contracts.mjs) alive.
 *
 * The image entrypoint gives every container start a fresh
 * COCKPIT_CONTEXT_INSTANCE_ID and the migration runner registers it with the image's
 * schema level. While a row of an older level was seen in the last 7 days,
 * no scheduled deletion that the older code might still need runs; `ready_at`
 * starts a newer level's 7-day soak. Without COCKPIT_CONTEXT_INSTANCE_ID (local dev,
 * tests) this is a no-op.
 *
 * Never throws: a database hiccup only delays scheduled deletions (fail-safe).
 */
import { hostname } from "node:os";
import { env } from "@cockpit-context/env/shared";

import prisma from "./index";
import { runnerTable } from "./runner-tables";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export type InstanceHeartbeat = {
  /** Record that this instance serves traffic and consumes in-process jobs. Idempotent. */
  markReady(): void;
  /** Stop ticking and await in-flight writes before disconnecting the database. */
  stop(): Promise<void>;
};

const NOOP: InstanceHeartbeat = { markReady() {}, async stop() {} };

/** A raw-query error for a missing relation (the runner tables do not exist yet). */
function isMissingTable(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(
    (error as { meta?: unknown } | null)?.meta ?? null,
  )}`;
  return /42P01|TableDoesNotExist|relation .* does not exist/.test(text);
}

export function startInstanceHeartbeat({ role }: { role: "server" }): InstanceHeartbeat {
  const id = env.COCKPIT_CONTEXT_INSTANCE_ID;
  if (!id) return NOOP;
  const table = runnerTable("_cockpit_context_instance");
  const host = hostname();
  let ready = false;
  let stopped = false;
  let levelChecked = false;
  let missingWarned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      // The runner's own registration normally exists already; inserting
      // here covers a process it did not register (its level stays NULL,
      // which keeps every scheduled deletion waiting: fail-safe).
      const rows = await prisma.$queryRaw<Array<{ schema_level: string | null }>>`
        INSERT INTO ${table} AS i (id, role, host, ready_at)
        VALUES (${id}::uuid, ${role}, ${host}, CASE WHEN ${ready} THEN now() END)
        ON CONFLICT (id) DO UPDATE SET last_seen_at = now(),
          ready_at = coalesce(i.ready_at, EXCLUDED.ready_at)
        RETURNING schema_level`;
      if (!levelChecked) {
        levelChecked = true;
        if ((rows[0]?.schema_level ?? null) === null)
          console.warn(
            `[instance] ${role} ${id} has no schema level (the migration runner did not register it); scheduled deletions wait while it runs.`,
          );
      }
    } catch (error) {
      if (isMissingTable(error)) {
        if (!missingWarned)
          console.warn(
            "[instance] the scheduled-deletion registry does not exist yet; this instance is not tracked until a migration runner creates it.",
          );
        missingWarned = true;
        return;
      }
      console.error("[instance] heartbeat failed; will retry.");
    }
  }

  function cycle() {
    if (stopped) return;
    clearTimeout(timer);
    chain = chain.then(tick).then(() => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(cycle, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
    });
  }

  cycle();
  return {
    markReady() {
      if (ready || stopped) return;
      ready = true;
      cycle();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await chain;
    },
  };
}
