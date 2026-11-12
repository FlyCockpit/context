import {
  COCKPIT_CONTEXT_RATE_BUDGET_IDS,
  COCKPIT_CONTEXT_RATE_BUDGETS,
  cockpitContextRateBudgetEnvDefaults,
} from "@cockpit-context/env/rate-budgets";
import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env stub: the reader reads on call, so a test can override one
// budget without re-importing anything.
const envMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@cockpit-context/env/server", () => ({ env: envMock }));

const { cockpitContextRateBudget, cockpitContextRateBudgets } = await import("./rate-budgets");
const { createProcedureBudget } = await import("./procedure-budget");

beforeEach(() => {
  for (const key of Object.keys(envMock)) delete envMock[key];
  Object.assign(envMock, cockpitContextRateBudgetEnvDefaults());
});

describe("cockpitContextRateBudget", () => {
  it("returns the old constants at the defaults", () => {
    // The default budget for each surface.
    expect(cockpitContextRateBudget("conversationRun")).toEqual({
      points: 60,
      durationSeconds: 3_600,
    });
    expect(cockpitContextRateBudget("conversationSteer")).toEqual({
      points: 120,
      durationSeconds: 600,
    });
    expect(cockpitContextRateBudget("summaryRegenerate")).toEqual({
      points: 10,
      durationSeconds: 3_600,
    });
    expect(cockpitContextRateBudget("repositoryRefresh")).toEqual({
      points: 20,
      durationSeconds: 600,
    });
    expect(cockpitContextRateBudget("registryLookup")).toEqual({
      points: 60,
      durationSeconds: 300,
    });
    expect(cockpitContextRateBudget("knownHostScan")).toEqual({ points: 20, durationSeconds: 600 });
    expect(cockpitContextRateBudget("sshKeyWrite")).toEqual({ points: 20, durationSeconds: 3_600 });
    expect(cockpitContextRateBudget("mcpTokenCreate")).toEqual({
      points: 20,
      durationSeconds: 3_600,
    });
    expect(cockpitContextRateBudget("packageWrite")).toEqual({ points: 60, durationSeconds: 600 });
    expect(cockpitContextRateBudget("mcpQuery")).toEqual({ points: 30, durationSeconds: 3_600 });
    expect(cockpitContextRateBudget("mcpToolCall")).toEqual({ points: 120, durationSeconds: 60 });
    expect(cockpitContextRateBudget("mcpIp")).toEqual({ points: 120, durationSeconds: 60 });
    expect(cockpitContextRateBudget("mcpCredential")).toEqual({ points: 240, durationSeconds: 60 });
    expect(cockpitContextRateBudget("mcpOauth")).toEqual({ points: 120, durationSeconds: 60 });
    expect(cockpitContextRateBudget("mcpConsent")).toEqual({ points: 30, durationSeconds: 60 });
    expect(cockpitContextRateBudget("mcpRegistration")).toEqual({
      points: 60,
      durationSeconds: 3_600,
    });
  });

  it("takes the count from env and keeps the window fixed", () => {
    envMock.COCKPIT_CONTEXT_STEERS_PER_10_MINUTES = 500;
    expect(cockpitContextRateBudget("conversationSteer")).toEqual({
      points: 500,
      durationSeconds: 600,
    });
  });

  it("throws, naming the variable, when the env value is missing or not a positive integer", () => {
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, "60"]) {
      envMock.COCKPIT_CONTEXT_RUNS_PER_HOUR = bad;
      expect(() => cockpitContextRateBudget("conversationRun")).toThrow(
        /COCKPIT_CONTEXT_RUNS_PER_HOUR/,
      );
    }
  });

  it("lists every budget in definition order", () => {
    envMock.COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES = 3;
    const list = cockpitContextRateBudgets();
    expect(list.map((budget) => budget.id)).toEqual(COCKPIT_CONTEXT_RATE_BUDGET_IDS);
    expect(list.find((budget) => budget.id === "knownHostScan")).toEqual({
      id: "knownHostScan",
      envKey: COCKPIT_CONTEXT_RATE_BUDGETS.knownHostScan.envKey,
      points: 3,
      windowSeconds: 600,
      keyedOn: "user",
    });
  });
});

describe("a procedure budget fed by cockpitContextRateBudget", () => {
  const build = (keyPrefix: string) =>
    createProcedureBudget({
      keyPrefix,
      budget: () => cockpitContextRateBudget("conversationRun"),
      failClosed: true,
      overBudgetMessage: (seconds) => `Too many questions. Try again in ${seconds}s.`,
      unavailableMessage: "Asking is temporarily unavailable.",
      unavailableLog: "[test] run budget unavailable:",
    });

  it("honors an override: COCKPIT_CONTEXT_RUNS_PER_HOUR=2 refuses the third run", async () => {
    envMock.COCKPIT_CONTEXT_RUNS_PER_HOUR = 2;
    const consume = build("rl:test-runs-override");
    await consume("user:a");
    await consume("user:a");
    const error = await consume("user:a").catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).code).toBe("TOO_MANY_REQUESTS");
    // Another user's bucket is untouched.
    await expect(consume("user:b")).resolves.toBeUndefined();
  });

  it("allows the default 60 and refuses the 61st", async () => {
    const consume = build("rl:test-runs-default");
    for (let i = 0; i < 60; i += 1) await consume("user:a");
    const error = await consume("user:a").catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).code).toBe("TOO_MANY_REQUESTS");
  });

  it("reads env on the first consume, not when the budget is declared", async () => {
    envMock.COCKPIT_CONTEXT_RUNS_PER_HOUR = undefined;
    const consume = build("rl:test-runs-lazy");
    envMock.COCKPIT_CONTEXT_RUNS_PER_HOUR = 1;
    await consume("user:a");
    const error = await consume("user:a").catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).code).toBe("TOO_MANY_REQUESTS");
  });

  it("fails closed when the budget cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    envMock.COCKPIT_CONTEXT_RUNS_PER_HOUR = undefined;
    const consume = build("rl:test-runs-broken");
    const error = await consume("user:a").catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).code).toBe("SERVICE_UNAVAILABLE");
  });
});
