// ---------------------------------------------------------------------------
// Cockpit Context's own rate budgets: one env var per budget, count only.
// ---------------------------------------------------------------------------
// Every Cockpit Context
// per-user, per-credential and whole-service budget is env-tunable and
// defaults to the shipped number. The template's AUTH / RPC / EMAIL families
// (`RATE_LIMIT_*`, packages/api/src/lib/rate-limit-families.ts) and the
// template's own `auth.verifyEmailTransport` budget are not in this table.
//
// Scheme: `COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW>` holds the COUNT; the window is fixed in
// code and named in the variable, as the two MCP variables that already
// existed (`COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR`, `COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE`)
// always did. The count is a whole number from 1 to MAX_RATE_BUDGET_COUNT:
// 0 is rejected, so no variable can turn a limiter off.
//
// Side-effect free so the env schema (./vars/server.ts), the one runtime
// reader (packages/api/src/lib/rate-budgets.ts) and test env mocks can share
// it without validating process.env.
// ---------------------------------------------------------------------------

export const MAX_RATE_BUDGET_COUNT = 100_000;

export interface CockpitContextRateBudgetDefinition {
  /** The env var that holds this budget's count. */
  envKey: string;
  /** The shipped count; the schema default. */
  defaultPoints: number;
  /** Fixed window, named in `envKey`. */
  windowSeconds: number;
  /**
   * Bucket key: who one bucket belongs to. `user-or-ip` is the signed-in
   * user when there is a session, else the client IP.
   */
  keyedOn: "user" | "user-or-ip" | "credential" | "ip" | "service";
}

export const COCKPIT_CONTEXT_RATE_BUDGETS = {
  /** `conversations.create` + `conversations.send`: one run each (model spend). */
  conversationRun: {
    envKey: "COCKPIT_CONTEXT_RUNS_PER_HOUR",
    defaultPoints: 60,
    windowSeconds: 3_600,
    keyedOn: "user",
  },
  /** `conversations.steer`: one saved steering turn each. */
  conversationSteer: {
    envKey: "COCKPIT_CONTEXT_STEERS_PER_10_MINUTES",
    defaultPoints: 120,
    windowSeconds: 600,
    keyedOn: "user",
  },
  /** `repositories.regenerateSummary`: one SUMMARY run each (model spend). */
  summaryRegenerate: {
    envKey: "COCKPIT_CONTEXT_SUMMARY_REGENERATIONS_PER_HOUR",
    defaultPoints: 10,
    windowSeconds: 3_600,
    keyedOn: "user",
  },
  /** `repositories.refresh`: one fetch from a user-named remote each. */
  repositoryRefresh: {
    envKey: "COCKPIT_CONTEXT_REPOSITORY_REFRESHES_PER_10_MINUTES",
    defaultPoints: 20,
    windowSeconds: 600,
    keyedOn: "user",
  },
  /** `packages.registryLookup`: one outbound registry request each. */
  registryLookup: {
    envKey: "COCKPIT_CONTEXT_REGISTRY_LOOKUPS_PER_5_MINUTES",
    defaultPoints: 60,
    windowSeconds: 300,
    keyedOn: "user",
  },
  /** `knownHosts.scan`: one outbound SSH handshake each. */
  knownHostScan: {
    envKey: "COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES",
    defaultPoints: 20,
    windowSeconds: 600,
    keyedOn: "user",
  },
  /** `sshKeys.generate` + `sshKeys.import`. */
  sshKeyWrite: {
    envKey: "COCKPIT_CONTEXT_SSH_KEY_WRITES_PER_HOUR",
    defaultPoints: 20,
    windowSeconds: 3_600,
    keyedOn: "user",
  },
  /** `mcpTokens.create`: one standing credential each. */
  mcpTokenCreate: {
    envKey: "COCKPIT_CONTEXT_MCP_TOKEN_CREATIONS_PER_HOUR",
    defaultPoints: 20,
    windowSeconds: 3_600,
    keyedOn: "user",
  },
  /** Saves that resolve a git URL's host (`packages.create`/`update`, `proposals.approve`, MCP auto-approve). */
  packageWrite: {
    envKey: "COCKPIT_CONTEXT_PACKAGE_WRITES_PER_10_MINUTES",
    defaultPoints: 60,
    windowSeconds: 600,
    keyedOn: "user",
  },
  /** MCP `query_dependency`: one model-spending run each. */
  mcpQuery: {
    envKey: "COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR",
    defaultPoints: 30,
    windowSeconds: 3_600,
    keyedOn: "credential",
  },
  /** MCP tool calls of any kind. */
  mcpToolCall: {
    envKey: "COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE",
    defaultPoints: 120,
    windowSeconds: 60,
    keyedOn: "credential",
  },
  /** `/mcp` before authentication (client IP only, never the presented token). */
  mcpIp: {
    envKey: "COCKPIT_CONTEXT_MCP_IP_REQUESTS_PER_MINUTE",
    defaultPoints: 120,
    windowSeconds: 60,
    keyedOn: "ip",
  },
  /** `/mcp` after authentication: protocol traffic of one verified credential. */
  mcpCredential: {
    envKey: "COCKPIT_CONTEXT_MCP_CREDENTIAL_REQUESTS_PER_MINUTE",
    defaultPoints: 240,
    windowSeconds: 60,
    keyedOn: "credential",
  },
  /** MCP OAuth authorize, token, revoke, public-client, prelogin, JWKS. */
  mcpOauth: {
    envKey: "COCKPIT_CONTEXT_MCP_OAUTH_REQUESTS_PER_MINUTE",
    defaultPoints: 120,
    windowSeconds: 60,
    keyedOn: "ip",
  },
  /** MCP OAuth consent and continue submissions (signed-in user, else IP). */
  mcpConsent: {
    envKey: "COCKPIT_CONTEXT_MCP_CONSENTS_PER_MINUTE",
    defaultPoints: 30,
    windowSeconds: 60,
    keyedOn: "user-or-ip",
  },
  /** Unauthenticated dynamic client registration: one bucket for the whole server. */
  mcpRegistration: {
    envKey: "COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR",
    defaultPoints: 60,
    windowSeconds: 3_600,
    keyedOn: "service",
  },
} as const satisfies Record<string, CockpitContextRateBudgetDefinition>;

export type CockpitContextRateBudgetId = keyof typeof COCKPIT_CONTEXT_RATE_BUDGETS;
export type CockpitContextRateBudgetEnvKey =
  (typeof COCKPIT_CONTEXT_RATE_BUDGETS)[CockpitContextRateBudgetId]["envKey"];

export const COCKPIT_CONTEXT_RATE_BUDGET_IDS = Object.keys(
  COCKPIT_CONTEXT_RATE_BUDGETS,
) as CockpitContextRateBudgetId[];

/**
 * Every budget var at its default, keyed by env name. For test env mocks of
 * `@cockpit-context/env/server`, so a mock cannot drift from the shipped numbers.
 */
export function cockpitContextRateBudgetEnvDefaults(): Record<
  CockpitContextRateBudgetEnvKey,
  number
> {
  return Object.fromEntries(
    COCKPIT_CONTEXT_RATE_BUDGET_IDS.map((id) => [
      COCKPIT_CONTEXT_RATE_BUDGETS[id].envKey,
      COCKPIT_CONTEXT_RATE_BUDGETS[id].defaultPoints,
    ]),
  ) as Record<CockpitContextRateBudgetEnvKey, number>;
}
