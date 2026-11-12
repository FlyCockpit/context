import { describe, expect, it } from "vitest";
import {
  COCKPIT_CONTEXT_RATE_BUDGET_IDS,
  COCKPIT_CONTEXT_RATE_BUDGETS,
  cockpitContextRateBudgetEnvDefaults,
  MAX_RATE_BUDGET_COUNT,
} from "./rate-budgets.js";
import { serverVars } from "./vars/server.js";

/**
 * The numbers every Cockpit Context limiter shipped with before the budgets became
 * env-tunable, as `[env var, count, window seconds]`.
 * Written out literally so a changed default is a deliberate edit here too.
 */
const SHIPPED: Record<string, [string, number, number]> = {
  conversationRun: ["COCKPIT_CONTEXT_RUNS_PER_HOUR", 60, 3_600],
  conversationSteer: ["COCKPIT_CONTEXT_STEERS_PER_10_MINUTES", 120, 600],
  summaryRegenerate: ["COCKPIT_CONTEXT_SUMMARY_REGENERATIONS_PER_HOUR", 10, 3_600],
  repositoryRefresh: ["COCKPIT_CONTEXT_REPOSITORY_REFRESHES_PER_10_MINUTES", 20, 600],
  registryLookup: ["COCKPIT_CONTEXT_REGISTRY_LOOKUPS_PER_5_MINUTES", 60, 300],
  knownHostScan: ["COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES", 20, 600],
  sshKeyWrite: ["COCKPIT_CONTEXT_SSH_KEY_WRITES_PER_HOUR", 20, 3_600],
  mcpTokenCreate: ["COCKPIT_CONTEXT_MCP_TOKEN_CREATIONS_PER_HOUR", 20, 3_600],
  packageWrite: ["COCKPIT_CONTEXT_PACKAGE_WRITES_PER_10_MINUTES", 60, 600],
  mcpQuery: ["COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR", 30, 3_600],
  mcpToolCall: ["COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE", 120, 60],
  mcpIp: ["COCKPIT_CONTEXT_MCP_IP_REQUESTS_PER_MINUTE", 120, 60],
  mcpCredential: ["COCKPIT_CONTEXT_MCP_CREDENTIAL_REQUESTS_PER_MINUTE", 240, 60],
  mcpOauth: ["COCKPIT_CONTEXT_MCP_OAUTH_REQUESTS_PER_MINUTE", 120, 60],
  mcpConsent: ["COCKPIT_CONTEXT_MCP_CONSENTS_PER_MINUTE", 30, 60],
  mcpRegistration: ["COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR", 60, 3_600],
};

const schemaFor = (envKey: string) => {
  const schema = (serverVars as Record<string, { safeParse: (v: unknown) => unknown }>)[envKey];
  if (!schema) throw new Error(`${envKey} is not declared in vars/server.ts`);
  return schema as (typeof serverVars)["COCKPIT_CONTEXT_RUNS_PER_HOUR"];
};

describe("Cockpit Context rate budgets", () => {
  it("keeps every shipped count and window as the default", () => {
    expect(Object.keys(COCKPIT_CONTEXT_RATE_BUDGETS).sort()).toEqual(Object.keys(SHIPPED).sort());
    for (const id of COCKPIT_CONTEXT_RATE_BUDGET_IDS) {
      const { envKey, defaultPoints, windowSeconds } = COCKPIT_CONTEXT_RATE_BUDGETS[id];
      expect([envKey, defaultPoints, windowSeconds]).toEqual(SHIPPED[id]);
      // The schema default is the same number (unset and empty both mean default).
      expect(schemaFor(envKey).parse(undefined)).toBe(defaultPoints);
    }
  });

  it("keeps the names the two MCP variables always had", () => {
    expect(COCKPIT_CONTEXT_RATE_BUDGETS.mcpQuery.envKey).toBe(
      "COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR",
    );
    expect(COCKPIT_CONTEXT_RATE_BUDGETS.mcpToolCall.envKey).toBe(
      "COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE",
    );
  });

  it("names the window in every variable, and every variable is unique", () => {
    const suffix: Record<number, RegExp> = {
      60: /_PER_MINUTE$/,
      300: /_PER_5_MINUTES$/,
      600: /_PER_10_MINUTES$/,
      3600: /_PER_HOUR$/,
    };
    const keys = COCKPIT_CONTEXT_RATE_BUDGET_IDS.map(
      (id) => COCKPIT_CONTEXT_RATE_BUDGETS[id].envKey,
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of COCKPIT_CONTEXT_RATE_BUDGET_IDS) {
      const { envKey, windowSeconds } = COCKPIT_CONTEXT_RATE_BUDGETS[id];
      expect(envKey).toMatch(/^COCKPIT_CONTEXT_/);
      expect(envKey).toMatch(suffix[windowSeconds] ?? /^$/);
    }
  });

  it("accepts whole numbers from 1 to the cap, trimmed", () => {
    const schema = schemaFor("COCKPIT_CONTEXT_RUNS_PER_HOUR");
    expect(schema.parse("1")).toBe(1);
    expect(schema.parse("250")).toBe(250);
    expect(schema.parse(" 42 ")).toBe(42);
    expect(schema.parse(String(MAX_RATE_BUDGET_COUNT))).toBe(MAX_RATE_BUDGET_COUNT);
  });

  it.each([
    ["0", "zero would disable the limiter"],
    ["-1", "negative"],
    ["1.5", "fractional"],
    ["1e3", "exponent notation"],
    ["0x10", "hex"],
    ["007", "leading zero"],
    ["ten", "not a number"],
    [String(MAX_RATE_BUDGET_COUNT + 1), "above the cap"],
  ])("rejects %s (%s) with a message naming the variable", (raw) => {
    for (const id of COCKPIT_CONTEXT_RATE_BUDGET_IDS) {
      const { envKey } = COCKPIT_CONTEXT_RATE_BUDGETS[id];
      const result = schemaFor(envKey).safeParse(raw);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(envKey);
      expect(result.error?.issues[0]?.message).toContain("cannot be 0 or turned off");
    }
  });

  it("builds a complete env mock at the defaults", () => {
    const defaults = cockpitContextRateBudgetEnvDefaults();
    expect(Object.keys(defaults)).toHaveLength(COCKPIT_CONTEXT_RATE_BUDGET_IDS.length);
    expect(defaults.COCKPIT_CONTEXT_RUNS_PER_HOUR).toBe(60);
    expect(defaults.COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR).toBe(60);
  });
});
