import {
  COCKPIT_CONTEXT_RATE_BUDGET_IDS,
  COCKPIT_CONTEXT_RATE_BUDGETS,
  type CockpitContextRateBudgetDefinition,
  type CockpitContextRateBudgetId,
} from "@cockpit-context/env/rate-budgets";
import { env } from "@cockpit-context/env/server";

// ---------------------------------------------------------------------------
// The ONE reader of Cockpit Context's per-budget env vars (`COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW>`).
// ---------------------------------------------------------------------------
// The definitions (env name, default, fixed window, bucket key) live in
// packages/env/src/rate-budgets.ts; the schema in packages/env/src/vars/server.ts
// validates each count at startup. Every Cockpit Context limiter takes its numbers from
// `cockpitContextRateBudget()`: the procedure budgets in packages/api/src/routers/*, the
// MCP tool budgets in apps/server/src/mcp/tools.ts and the MCP HTTP surfaces
// in apps/server/src/rate-limit.ts. `settings.runtimeConfig` lists them all
// through `cockpitContextRateBudgets()`.
//
// Read on call, not at import: procedure budgets build their limiter on first
// consume, so importing the router graph never needs these keys in an env mock.
// ---------------------------------------------------------------------------

export interface RateBudget {
  points: number;
  durationSeconds: number;
}

export interface EffectiveRateBudget {
  id: CockpitContextRateBudgetId;
  envKey: string;
  points: number;
  windowSeconds: number;
  keyedOn: CockpitContextRateBudgetDefinition["keyedOn"];
}

function readPoints(id: CockpitContextRateBudgetId): number {
  const { envKey } = COCKPIT_CONTEXT_RATE_BUDGETS[id];
  const points: unknown = env[envKey];
  if (typeof points !== "number" || !Number.isInteger(points) || points < 1) {
    throw new TypeError(
      `[rate-limit] ${envKey} must be a positive integer, got ${String(points)}. ` +
        "The env schema enforces this, so a bad value here almost certainly means a " +
        "test mocked @cockpit-context/env/server without the budget keys (spread " +
        "cockpitContextRateBudgetEnvDefaults() from @cockpit-context/env/rate-budgets into the mock).",
    );
  }
  return points;
}

/** One budget's effective count and window, for a limiter. */
export function cockpitContextRateBudget(id: CockpitContextRateBudgetId): RateBudget {
  return {
    points: readPoints(id),
    durationSeconds: COCKPIT_CONTEXT_RATE_BUDGETS[id].windowSeconds,
  };
}

/** Every Cockpit Context budget after defaults, in definition order (admin runtime config). */
export function cockpitContextRateBudgets(): EffectiveRateBudget[] {
  return COCKPIT_CONTEXT_RATE_BUDGET_IDS.map((id) => {
    const { envKey, windowSeconds, keyedOn } = COCKPIT_CONTEXT_RATE_BUDGETS[id];
    return { id, envKey, points: readPoints(id), windowSeconds, keyedOn };
  });
}
