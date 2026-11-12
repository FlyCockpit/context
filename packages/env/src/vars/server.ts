import { z } from "zod";
import { isValidEncryptionKeyring } from "../encryption-keyring.js";
import {
  COCKPIT_CONTEXT_RATE_BUDGETS,
  type CockpitContextRateBudgetDefinition,
  MAX_RATE_BUDGET_COUNT,
} from "../rate-budgets.js";
import { httpUrl, originUrl } from "../url.js";
import { strictBooleanFlag } from "./shared.js";

/**
 * One Cockpit Context rate budget's count (`COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW>`, ../rate-budgets.ts):
 * digits only, 1 to MAX_RATE_BUDGET_COUNT. Stricter than `z.coerce.number()`
 * on purpose: "0", "-1", "1.5", "1e3", "0x10" and "ten" all fail startup with
 * a message naming the variable, so a typo can never silently disable or
 * reshape a limiter.
 */
function rateBudgetCount({ envKey, defaultPoints }: CockpitContextRateBudgetDefinition) {
  const message = `${envKey} must be a whole number from 1 to ${MAX_RATE_BUDGET_COUNT} (a rate budget cannot be 0 or turned off)`;
  return z
    .string()
    .trim()
    .regex(/^[1-9][0-9]*$/, message)
    .transform(Number)
    .pipe(z.number().int().min(1, message).max(MAX_RATE_BUDGET_COUNT, message))
    .default(defaultPoints);
}

const GIT_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why one `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST` entry is not an exact,
 * fully qualified host name, or null when it is one.
 */
function gitHostAllowlistEntryProblem(entry: string): string | null {
  if (entry.includes("*")) return "wildcards are not allowed";
  if (entry.includes("/") || entry.includes("@")) return "list host names, not URLs";
  if (entry.includes(":") || entry.includes("[")) {
    return "ports and IPv6 literals are not allowed";
  }
  if (entry === "localhost" || entry.endsWith(".localhost")) return "localhost is never allowed";
  if (entry.length > 253 || entry.endsWith(".")) return "not a valid host name";
  const labels = entry.split(".");
  if (labels.length < 2 || !labels.every((label) => GIT_HOST_LABEL.test(label))) {
    return "must be a fully qualified host name (e.g. gitlab.corp.example)";
  }
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return "IP literals are not allowed";
  return null;
}

/**
 * `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST`: comma-separated exact host names,
 * trimmed and lowercased into a sorted, de-duplicated array. Unset or empty
 * is `[]`. Any bad entry fails startup with a message naming it.
 */
function gitHostAllowlist() {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const hosts = new Set<string>();
      for (const part of (raw ?? "").split(",")) {
        const entry = part.trim().toLowerCase();
        if (entry === "") continue;
        const problem = gitHostAllowlistEntryProblem(entry);
        if (problem) {
          ctx.addIssue({
            code: "custom",
            message: `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST entry "${entry}": ${problem}`,
          });
          return z.NEVER;
        }
        hosts.add(entry);
      }
      return [...hosts].sort();
    });
}

/**
 * A per-user concurrency or count cap (`COCKPIT_CONTEXT_MAX_<WHAT>_PER_USER`): not a
 * per-window budget, so not in ../rate-budgets.ts, but validated the same
 * way and for the same reason — digits only, 1 to MAX_RATE_BUDGET_COUNT, so
 * no value can turn the cap off.
 */
function perUserCap(envKey: string, defaultCount: number) {
  const message = `${envKey} must be a whole number from 1 to ${MAX_RATE_BUDGET_COUNT} (a cap cannot be 0 or turned off)`;
  return z
    .string()
    .trim()
    .regex(/^[1-9][0-9]*$/, message)
    .transform(Number)
    .pipe(z.number().int().min(1, message).max(MAX_RATE_BUDGET_COUNT, message))
    .default(defaultCount);
}

// ---------------------------------------------------------------------------
// Server-only variable DECLARATIONS. See ./shared.ts for why these live in a
// side-effect-free module of their own.
//
// Disjointness contract: no key declared here may also appear in ./shared.ts —
// `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const serverVars = {
  // In-process background job runner (packages/jobs): jobs executed at once.
  JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  // Optional process port override. Portless and production platforms inject
  // `PORT`; `SERVER_PORT` is only for raw local runs or container overrides.
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: originUrl("BETTER_AUTH_URL"),
  CORS_ORIGIN: originUrl("CORS_ORIGIN").optional(),
  SSO_ENABLED: strictBooleanFlag(),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional(),
  SSO_ISSUER: z.string().optional(),
  SSO_PROVIDER_NAME: z.string().default("SSO"),
  FORCE_SSO: strictBooleanFlag(),
  SIGNUP_ENABLED: strictBooleanFlag(),
  // ---- Rate limiting: three named budgets, two knobs each. -----------------
  // Each budget describes its family's REFERENCE member (the number below);
  // every other limiter in the family keeps its ratio to that reference, so
  // setting a budget re-tunes the whole family coherently:
  //
  //   • POINTS multiplies every family member's points by provided/reference.
  //   • WINDOW_SECONDS multiplies every member's window AND block duration by
  //     the same factor (the window:block ratio is part of each member's
  //     design and moves as a unit).
  //
  // Why not one knob per limiter: a per-surface
  // knob invites squeezing one budget to "be safe" — which locks out a
  // shared office behind one NAT IP — instead of SPLITTING the surface that
  // needs its own bucket. Tighter is not safer; if one surface 429s
  // legitimate users, split the surface instead of shrinking a budget.
  // Burst/sustained ratios, bucket keying, and fail-open/fail-closed stay
  // fixed in code (apps/server/src/rate-limit.ts +
  // packages/api/src/lib/rate-limit-families.ts). Defaults reproduce the
  // shipped numbers exactly.
  //
  // AUTH family — the fail-closed /api/auth/* limiters: general auth surface
  // (this reference, 30/60 s + 5-min block), credential (10/60 s),
  // credential burst (3/10 s), signup (10/h), and 2FA-OTP resend
  // (3/15 min). IP-keyed, so shared-NAT
  // offices share these budgets — size for several concurrent humans.
  RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // RPC family — ordinary request volume: /rpc/* (this reference, 100/60 s),
  // /ready (60), and the SSR catch-all (300).
  RATE_LIMIT_RPC_POINTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_RPC_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // EMAIL family — per-RECIPIENT caps on the anonymous endpoints that mail a
  // caller-supplied address: verification resend / password reset (this
  // reference, 3 per hour), signup (6), and sign-in-triggered mails (10).
  // The 0-second block stays code-fixed: a block on a caller-supplied key is
  // an unauthenticated lockout lever against that user's password reset.
  RATE_LIMIT_EMAIL_POINTS: z.coerce.number().int().min(0).default(3),
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Number of reverse-proxy hops in front of the app, for deriving the real
  // client IP used as the anonymous rate-limit key.
  //
  // Leave UNSET (the default) for zero-config behaviour that is correct for
  // every deploy target in our docs (Render, Railway, Dokploy/nginx, Azure
  // Container Apps): the app trusts the client IP that a proxy on a
  // private/loopback network forwarded, and otherwise (bare deployment, local
  // dev) keys on the real socket peer. See apps/server/src/client-ip.ts.
  //
  // Set this only when a proxy in front of the app has a PUBLIC IP (e.g.
  // Cloudflare, a public load balancer) or your topology is fixed: it is the
  // exact number of proxies between the client and the app. 0 disables
  // X-Forwarded-For entirely and always keys on the socket peer.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
  ADMIN_EMAILS: z.string().optional(),
  // TTL (seconds) for the in-memory SSR HTML cache of public pages
  // (apps/server/src/ssr-cache.ts). 0 disables the cache entirely; the
  // default keeps a cached public render for up to a minute. Edits to a live
  // URL can take up to this long to appear.
  SSR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),

  // ---- Cockpit Context --------------------------------------------------------------
  // Root of the on-disk state: bare clones (repos/), worktrees (checkouts/)
  // and per-invocation SSH temp files (tmp/). Optional here; the fallback is
  // applied in ../server.ts (`/data` in production, `<repo>/.data` otherwise),
  // and a relative value resolves against the repository root, not the cwd.
  COCKPIT_CONTEXT_DATA_DIR: z.string().min(1).optional(),
  // Decimal GB (10^9 bytes). Automatic pruning evicts least-recently-used
  // checkouts, then clones, until usage is under 90 % of this cap.
  COCKPIT_CONTEXT_MAX_STORAGE_GB: z.coerce.number().positive().max(100_000).default(20),
  // AES-256-GCM keyring for secrets at rest (SSH private keys):
  // `v1:<base64 32 bytes>[,older:<base64>…]`. The first entry encrypts, all
  // decrypt. Required in production (../server.ts); `pnpm run setup` mints a
  // local one. Format: ../encryption-keyring.ts.
  COCKPIT_CONTEXT_ENCRYPTION_KEYS: z
    .string()
    .refine(isValidEncryptionKeyring, {
      message:
        "COCKPIT_CONTEXT_ENCRYPTION_KEYS must be `<version>:<base64 32-byte key>[,…]` with unique versions",
    })
    .optional(),
  // OpenRouter model ids for the investigation agent. COCKPIT_CONTEXT_MODEL is required
  // once OPENROUTER_API_KEY is set (../server.ts); the helper model defaults
  // to COCKPIT_CONTEXT_MODEL in application code.
  COCKPIT_CONTEXT_MODEL: z.string().min(1).optional(),
  COCKPIT_CONTEXT_HELPER_MODEL: z.string().min(1).optional(),
  // The API the agent speaks to the model endpoint: OpenAI Chat Completions,
  // OpenAI Responses or Anthropic Messages. OpenRouter serves all three.
  COCKPIT_CONTEXT_MODEL_API: z
    .enum(["chat-completions", "responses", "messages"])
    .default("chat-completions"),
  // API root ending in /v1 (default OpenRouter's); the chosen API's path is
  // appended. For the local fake OpenRouter server or a compatible gateway.
  // Production refuses a non-https value; the messages API needs the /v1.
  COCKPIT_CONTEXT_OPENROUTER_BASE_URL: httpUrl("COCKPIT_CONTEXT_OPENROUTER_BASE_URL").optional(),
  // Per-run budgets for the explore agent. Helper budgets scale from these.
  COCKPIT_CONTEXT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(1000).default(100),
  COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(86_400).default(600),
  // Longest a model request may go without sending any data. Before the first
  // token the request is retried (then failed over); mid-answer the dispatch
  // fails, instead of holding a run slot until COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS.
  COCKPIT_CONTEXT_MODEL_STALL_SECONDS: z.coerce.number().int().min(10).max(3600).default(90),
  // Run concurrency: a global cap and a per-user cap. Excess runs queue.
  // Overview summary runs count toward the global cap only.
  COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(64).default(4),
  COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER: z.coerce.number().int().min(1).max(64).default(3),
  // Main runs one user may have waiting for a slot (preparing or queued, not
  // yet running) at once, web and MCP together. Past it a new question is
  // refused with BUSY instead of growing the queue (packages/runs/src/engine.ts).
  // Summary runs never count. 0 = unlimited.
  COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER: z.coerce.number().int().min(0).max(10_000).default(20),
  // Owner-scoped MCP answer reuse (packages/runs/src/answer-reuse.ts):
  // identical concurrent `query_dependency` questions share one investigation,
  // and a completed answer is reused for the same owner, commit, notes,
  // overview override, question and model config until it expires. Never
  // across users. `false` turns both off.
  COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED: strictBooleanFlag(true),
  COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(604_800)
    .default(3600),
  COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(500),
  // Version -> commit resolutions of exact versions, tags and full commit ids
  // (never branches or the default branch) are reused for this long, so
  // repeated questions skip the registry lookup and tag fetch
  // (packages/repos/src/resolution-cache.ts). 0 turns the cache off.
  COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(300),
  COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(1000),
  // Longest a `query_dependency` / `get_query_result` call waits for an answer
  // before returning `running` (also the cap on the caller's `wait_seconds`).
  COCKPIT_CONTEXT_MCP_WAIT_SECONDS: z.coerce.number().int().min(0).max(3600).default(900),
  // ---- Cockpit Context rate budgets (in memory, one per surface) ----------------------
  // Each holds a COUNT; the window is fixed and named in the variable. What
  // each one meters, its window and its bucket key: ../rate-budgets.ts. Read
  // only through packages/api/src/lib/rate-budgets.ts.
  COCKPIT_CONTEXT_RUNS_PER_HOUR: rateBudgetCount(COCKPIT_CONTEXT_RATE_BUDGETS.conversationRun),
  COCKPIT_CONTEXT_STEERS_PER_10_MINUTES: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.conversationSteer,
  ),
  COCKPIT_CONTEXT_SUMMARY_REGENERATIONS_PER_HOUR: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.summaryRegenerate,
  ),
  COCKPIT_CONTEXT_REPOSITORY_REFRESHES_PER_10_MINUTES: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.repositoryRefresh,
  ),
  COCKPIT_CONTEXT_REGISTRY_LOOKUPS_PER_5_MINUTES: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.registryLookup,
  ),
  COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.knownHostScan,
  ),
  COCKPIT_CONTEXT_SSH_KEY_WRITES_PER_HOUR: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.sshKeyWrite,
  ),
  COCKPIT_CONTEXT_MCP_TOKEN_CREATIONS_PER_HOUR: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.mcpTokenCreate,
  ),
  COCKPIT_CONTEXT_PACKAGE_WRITES_PER_10_MINUTES: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.packageWrite,
  ),
  // Per-credential MCP budgets: `query_dependency` calls per hour (each one is
  // a model-spending run) and tool calls of any kind per minute.
  COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR: rateBudgetCount(COCKPIT_CONTEXT_RATE_BUDGETS.mcpQuery),
  COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.mcpToolCall,
  ),
  // Per-USER cap on `query_dependency` calls per hour across all of one
  // user's tokens and OAuth grants (apps/server/src/mcp/tools.ts). Default
  // 120. Not a rate budget (../rate-budgets.ts): 0 means unlimited, so only
  // the per-credential COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR applies. Digits only.
  COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR: z
    .string()
    .trim()
    .regex(
      /^[0-9]+$/,
      "COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR must be a whole number (0 = unlimited)",
    )
    .transform(Number)
    .pipe(z.number().int().min(0).max(MAX_RATE_BUDGET_COUNT))
    .default(120),
  // Per-user caps on what one person (all their credentials and tabs
  // together) may hold at once. In memory, like the budgets. Raise them for
  // a heavy automated user; they cannot be turned off.
  // Pending `propose_dependency` proposals (apps/server/src/mcp/tools/proposals.ts).
  COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER: perUserCap(
    "COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER",
    100,
  ),
  // `get_query_result` calls waiting at once (apps/server/src/mcp/tools/query.ts);
  // past it a call answers `running` at once instead of waiting.
  COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER: perUserCap(
    "COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER",
    10,
  ),
  // Open live streams, `conversations.watch` + `conversations.activity`
  // together (packages/api/src/routers/conversations.ts).
  COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER: perUserCap(
    "COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER",
    20,
  ),
  // The MCP HTTP surfaces (apps/server/src/mcp/mount.ts, oauth-routes.ts).
  COCKPIT_CONTEXT_MCP_IP_REQUESTS_PER_MINUTE: rateBudgetCount(COCKPIT_CONTEXT_RATE_BUDGETS.mcpIp),
  COCKPIT_CONTEXT_MCP_CREDENTIAL_REQUESTS_PER_MINUTE: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.mcpCredential,
  ),
  COCKPIT_CONTEXT_MCP_OAUTH_REQUESTS_PER_MINUTE: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.mcpOauth,
  ),
  COCKPIT_CONTEXT_MCP_CONSENTS_PER_MINUTE: rateBudgetCount(COCKPIT_CONTEXT_RATE_BUDGETS.mcpConsent),
  COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR: rateBudgetCount(
    COCKPIT_CONTEXT_RATE_BUDGETS.mcpRegistration,
  ),
  // Exact host names (comma-separated) whose git remotes may resolve to an
  // internal address: RFC 1918, CGNAT 100.64.0.0/10 or IPv6 unique-local.
  // Loopback, link-local and cloud-metadata addresses stay refused even for a
  // listed host (packages/repos/src/address-policy.ts). Operator-only (env);
  // no wildcards, ports or IP literals. docs/deploy.md § Internal git hosts.
  COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST: gitHostAllowlist(),
  // A branch/default-ref resolution fetches only when the last fetch is older.
  COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  // Language servers stop after this much idle time; at most this many run.
  COCKPIT_CONTEXT_LSP_IDLE_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  COCKPIT_CONTEXT_LSP_MAX_SERVERS: z.coerce.number().int().min(0).max(32).default(4),
  // Language servers run inside Cockpit Context's Landlock sandbox (`required`); without
  // the helper or a kernel with Landlock the LSP tools are disabled, never run
  // unsandboxed. `off` runs them directly and logs a warning: development
  // hosts only.
  COCKPIT_CONTEXT_LSP_SANDBOX: z.enum(["required", "off"]).default("required"),
  // Conversations (with their runs and turns) are deleted this many days
  // after their last activity by the `conversations.retention` job. 0 keeps
  // them until their owner deletes them.
  COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(36_500)
    .default(90),
  // Who runs this instance, shown on the public privacy notice and published
  // through the public `appConfig` procedure. Both optional; unset renders
  // neutral "not published" text.
  COCKPIT_CONTEXT_OPERATOR_NAME: z.string().trim().min(1).max(200).optional(),
  COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL: z
    .string()
    .trim()
    .max(254)
    .email({ message: "COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL must be an email address" })
    .optional(),
};
