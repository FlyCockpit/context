import { ORPCError } from "@orpc/server";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";

/**
 * The budget's numbers: literal (template budgets such as
 * `auth.verifyEmailTransport`), or `budget`, resolved on first consume (Cockpit Context
 * budgets, `() => cockpitContextRateBudget(id)` from ./rate-budgets, env-tunable).
 */
type ProcedureBudgetLimits =
  | { points: number; durationSeconds: number; budget?: never }
  | {
      budget: () => { points: number; durationSeconds: number };
      points?: never;
      durationSeconds?: never;
    };

export type ProcedureBudgetOptions = ProcedureBudgetLimits & {
  /** Distinct `keyPrefix` is what makes this budget independent of others. */
  keyPrefix: string;
  /**
   * What to do if the limiter itself throws something other than a rejection
   * (an in-memory limiter should not, but the contract stays explicit).
   * Fail-closed refuses the procedure; fail-open logs and lets the call
   * through — never for spend, mail, or unbounded writes.
   */
  failClosed: boolean;
  overBudgetMessage: (retryAfterSeconds: number) => string;
  unavailableMessage: string;
  unavailableLog: string;
};

/**
 * Procedure-layer rate budget. Use this for oRPC procedures that spend,
 * send mail, or write rows — a batched `/rpc/<prefix>/__batch__` POST is
 * one HTTP request, so the Hono `/rpc/*` limiter cannot see per-procedure
 * cost.
 *
 * In-memory and process-local, like every limiter in this repo: Cockpit Context runs
 * exactly one app replica (docs/hosting.md). Built on first consume, not
 * at module load, so importing the router graph costs nothing.
 */
export function createProcedureBudget(
  options: ProcedureBudgetOptions,
): (key: string) => Promise<void> {
  let limiter: RateLimiterMemory | undefined;
  const getLimiter = (): RateLimiterMemory => {
    if (!limiter) {
      const { points, durationSeconds } = options.budget ? options.budget() : options;
      limiter = new RateLimiterMemory({
        keyPrefix: options.keyPrefix,
        points,
        duration: durationSeconds,
      });
    }
    return limiter;
  };

  return async (key: string): Promise<void> => {
    try {
      await getLimiter().consume(key);
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        const retryAfterSeconds = Math.ceil(error.msBeforeNext / 1000);
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: options.overBudgetMessage(retryAfterSeconds),
          data: { retryAfterSeconds },
        });
      }
      if (options.failClosed) {
        console.error(options.unavailableLog, error);
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: options.unavailableMessage,
        });
      }
      console.warn(options.unavailableLog, error);
    }
  };
}
