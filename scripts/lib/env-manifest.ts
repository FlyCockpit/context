/**
 * THE canonical description of every environment variable in this repo.
 *
 * Three things read this file:
 *   1. `pnpm generate:secrets`  (scripts/generate-secrets.ts)  — builds a
 *      ready-to-paste production env block, generating what it can and
 *      prompting for what it can't.
 *   2. `pnpm env:sync`          (scripts/sync-env-example.ts)  — regenerates
 *      `.env.example`, `apps/web/.env.example`.
 *      Those files are GENERATED. Do not hand-edit them; edit this
 *      manifest and re-run the script.
 *   3. `pnpm env:check`         (same script, `--check`)       — CI gate. Fails
 *      when a key declared in a `packages/env/src/vars/*.ts` Zod schema is
 *      missing here, or when a generated `.env.example` is stale.
 *
 * ---------------------------------------------------------------------------
 * ADDING A NEW ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 *   1. Declare it in the right `packages/env/src/vars/*.ts` object (shared =
 *      server + shared packages/scripts, server = server-only, web = VITE_*) — never inline in the `createEnv({…})` call one
 *      directory up, which the scan cannot see.
 *   2. Add an entry to `ENV_VARS` below, in an existing group or a new one.
 *   3. Run `pnpm env:sync` and commit the regenerated `.env.example` files.
 *
 * Skipping step 2 fails CI — that is deliberate. A variable that the generator
 * doesn't know about is a variable that silently goes missing from a
 * production deploy and surfaces as a boot crash weeks later.
 *
 * When removing a feature module, delete that module's
 * group and its vars from this file, then run `pnpm env:sync`.
 */

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

/**
 * Deploy targets the generator knows about. Dokploy on a VPS is the repo's
 * deployment target; see `docs/deploy.md`.
 */
export const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS (docker compose)",
    doc: "docs/deploy.md",
    injects: [],
    note: "The compose stack builds DATABASE_URL from POSTGRES_PASSWORD (generate with openssl rand -hex 24); leave DATABASE_URL blank. Configure off-site backups in a private S3-compatible bucket.",
  },
  {
    id: "other",
    label: "Other / not sure",
    doc: "docs/deploy.md",
    injects: [],
    note: "Prompting for every non-defaulted variable. Delete anything your platform injects for you.",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which .env file a variable belongs to. */
export type EnvFile = "root" | "web";

interface EnvGroup {
  id: string;
  /** Section heading in the generated .env.example. */
  title: string;
  file?: EnvFile;
  /** Always included; never prompted for. */
  always?: boolean;
  /**
   * Yes/no question gating the whole group in `pnpm generate:secrets`.
   * Omitted for `always` groups and for `tuning` groups.
   */
  prompt?: string;
  /** Default answer to `prompt`. */
  default?: boolean;
  /**
   * Tuning-only group: every var has a schema default, so the generator emits
   * the whole group commented out and never prompts.
   */
  tuning?: boolean;
  /**
   * Force this group on (skipping its yes/no) when an earlier answer makes it
   * mandatory. Without this, a missing required integration
   * only surfaces in the final validation pass, after every prompt has been
   * answered, and the whole run has to be redone.
   */
  requiredWhen?: { key: string; equals: string; because: string };
  /**
   * Offer to reuse this group's values from the shell environment the script
   * runs in, when they are already set there. Meant for credentials you hold
   * once and point several applications at (SMTP, object storage, an LLM
   * key) — not for per-app values like BETTER_AUTH_URL or DATABASE_URL, where
   * silently inheriting another app's value is a footgun.
   */
  reuseFromEnv?: boolean;
  /** Comment block emitted above the section. */
  comment?: string[];
}

export interface EnvVar {
  key: string;
  group: string;
  /**
   * - `generate`: the script produces a value with `generator`.
   * - `prompt`:   only you know it — the script asks.
   * - `confirm`:  yes/no question; emits `"true"` only when the answer is yes
   *               (schema default covers the no case).
   * - `enable`:   when this var's group is selected, emit `"true"` automatically
   *               (feature flags that must flip on with their optional block).
   * - `default`:  a documented default value covers it, so the generator never
   *               asks and omits the key (shown commented out under `--all`).
   * - `manual`:   deliberate opt-in with no useful prompt; same emission as
   *               `default`, but documented in `.env.example` (rare — prefer
   *               `prompt`).
   */
  source: "generate" | "prompt" | "confirm" | "enable" | "default" | "manual";
  generator?: "secret32" | "encryptionKeyring";
  /**
   * The effective default, for documentation only — setting this changes
   * nothing at runtime. Usually mirrors a Zod `.default()`; see `defaultFrom`
   * for the handful that come from application code instead.
   */
  default?: string;
  /**
   * Where `default` actually comes from. `"schema"` (the assumed case) means a
   * Zod `.default()`. `"app"` means the schema field is optional and the
   * fallback lives in application code — say so explicitly, because
   * `pnpm env:check` compares key sets, not defaults, and cannot catch this
   * drifting.
   */
  defaultFrom?: "schema" | "app";
  /**
   * Fixed set of valid values. Rendered as an `Allowed: …` line in
   * `.env.example`, and offered as a pick-list instead of a free-text prompt.
   */
  choices?: Array<{ value: string; label?: string; description?: string }>;
  /**
   * Shape-check applied at the prompt, mirroring the Zod refinement that would
   * otherwise only fire in the final validation pass — so a typo costs one
   * retry instead of the whole run.
   */
  format?: "origin";
  /**
   * Set `false` to keep this var OUT of its group's reuse-from-environment
   * offer, even when the group has `reuseFromEnv`. For values that identify one
   * specific app rather than a shared provider account — inheriting those
   * silently points the new app at the previous one's resources.
   */
  reusable?: boolean;
  /**
   * Let the operator skip this otherwise-required var (empty answer = omit).
   * For values a platform may supply out of band — the generator records the
   * omission in the output header instead of blocking on it.
   */
  omittable?: boolean;
  /** Required once its group is enabled. Prompts are re-asked until answered. */
  required?: boolean;
  /** Question text for `source: "prompt"` / `source: "confirm"`. */
  prompt?: string;
  /** Default answer for `source: "confirm"` (false when omitted). */
  confirmDefault?: boolean;
  /** Extra guidance printed under the prompt. */
  hint?: string;
  /** Placeholder shown in the generated .env.example. */
  example?: string;
  /**
   * Emit this var UNCOMMENTED in the generated .env.example. Reserve it for
   * vars whose `example` is a working local-dev value — a live line with a
   * non-functional placeholder is worse than a commented one, because
   * `emptyStringAsUndefined` won't save you from a wrong value.
   * `source: "generate"` vars are always emitted live but empty.
   */
  exampleSet?: boolean;
  /** True for values that must never be echoed back or logged. */
  secret?: boolean;
  file?: EnvFile;
  /**
   * Set `false` for variables read outside the Zod schemas (e.g. by a shell
   * entrypoint). Excludes the key from the schema-coverage check's expectation
   * that every manifest key is also a schema key.
   */
  inSchema?: boolean;
  /** Comment lines emitted above the var. */
  comment?: string[];
  /**
   * Render into the trailing "Advanced tuning" section of the root
   * `.env.example` instead of the var's own feature section — for one-off
   * knobs a nontechnical operator should never touch (rate-limit budgets,
   * codec settings, cache TTLs). Always commented with the default shown.
   * The manifest and `generate:secrets --all` are unaffected; only the
   * `.env.example` placement moves.
   */
  advanced?: boolean;
  /**
   * Omit from the generated `.env.example` entirely. For deep one-shot knobs
   * whose audience reads the deployment docs — the full catalog stays
   * here and in the Zod schema. Only valid on `source: "default"` /
   * `"manual"` vars (never on anything prompted, generated, or enabling).
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const ENV_GROUPS: EnvGroup[] = [
  {
    id: "core",
    title: "Datastores — [shared]",
    always: true,
  },
  {
    id: "runtime",
    title: "Runtime + migrations — [shared]",
    always: true,
    comment: [
      "The server applies committed migrations before starting by default.",
      "For a separate migration job, set MIGRATE_ON_START=false and run the",
      "image's migrate command before starting the server.",
    ],
  },
  {
    id: "backups",
    title: "Database backups — [shared]",
    prompt: "Configure off-site database backups (S3/R2)?",
    default: true,
    comment: [
      "Verified pg_dump backups are saved to /backups before migrations.",
      "BACKUP_SCHEDULE=daily also takes a daily dump. Set a private S3 bucket",
      "for off-site copies and a lifecycle rule to expire old objects.",
      "Use dedicated backup writer credentials and a separate ListBucket-only",
      "BACKUP_MONITOR_S3_* identity for the app's freshness check.",
      "Keep a verified backup and test restore before upgrading.",
    ],
  },
  {
    id: "auth",
    title: "Auth — [server-only]",
    always: true,
  },
  {
    id: "admin",
    title: "Admin + signup — [server-only]",
    always: true,
  },
  {
    id: "cockpit-context",
    title: "Cockpit Context storage + encryption — [server-only]",
    always: true,
    comment: [
      "Clones, worktrees and SSH temp files live under COCKPIT_CONTEXT_DATA_DIR (mount a",
      "volume there). COCKPIT_CONTEXT_ENCRYPTION_KEYS encrypts SSH private keys at rest;",
      "losing it makes every stored key unreadable, so back it up with the database.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy: conversation retention + operator identity — [server-only]",
    always: true,
    comment: [
      "Conversations are deleted automatically this many days after their last",
      "activity (0 keeps them until deleted). The operator name and contact",
      "address appear on the public privacy notice; unset, it says no contact",
      "details have been published.",
    ],
  },
  {
    id: "agent",
    reuseFromEnv: true,
    title: "Investigation agent (OpenRouter) — [server-only]",
    prompt: "Configure the investigation agent (OpenRouter API key + model)?",
    default: true,
    comment: [
      "Cockpit Context answers questions with an OpenRouter model. Without OPENROUTER_API_KEY",
      "the app boots but every investigation fails. Run budgets and concurrency",
      "caps are in the Advanced tuning section.",
    ],
  },
  {
    id: "smtp",
    reuseFromEnv: true,
    title: "Email (SMTP) — [shared]",
    prompt: "Configure outgoing email (SMTP)?",
    default: true,
    comment: [
      "Optional. With SMTP set, signup requires email verification and password",
      "reset works. Without it, accounts are created verified and password reset",
      "is unavailable.",
      "Local dev: `pnpm dev:services` starts a mailpit sink and `pnpm run setup`",
      "  fills these three lines automatically; read captured mail at",
      "  http://localhost:8025",
    ],
  },
  {
    id: "sso",
    title: "SSO / enterprise login — [server-only]",
    prompt: "Configure SSO (OIDC) login?",
    default: false,
    comment: [
      "Optional. FORCE_SSO=true in production requires SSO_ENABLED plus all",
      "three SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_ISSUER values, or the",
      "server throws at boot.",
    ],
  },
  {
    id: "translation",
    reuseFromEnv: true,
    title: "Translation provider — [shared]",
    prompt: "Enable i18n bundle translation?",
    default: false,
    comment: [
      "Used by `pnpm i18n:translate`. The openrouter provider reuses",
      "OPENROUTER_API_KEY from the investigation-agent section.",
      "The app boots without these; the translator throws on first use if the",
      "chosen provider's key is missing. Default provider is `openrouter` with",
      "`anthropic/claude-haiku-4-5`.",
    ],
  },
  {
    id: "ratelimit",
    title: "Rate limiting — [server-only]",
    tuning: true,
    comment: [
      "Three named budgets (AUTH, RPC, EMAIL), two knobs",
      "each. Each budget describes its family's reference member; every other",
      "limiter in the family scales with it at its designed ratio, so setting",
      "a budget re-tunes the whole family coherently. Defaults are sensible;",
      "tighter is not safer — if a surface 429s legitimate users, split the",
      "surface instead of shrinking a budget.",
    ],
  },
  {
    id: "limits",
    title: "Cache limits — [server-only]",
    tuning: true,
    comment: ["Optional tuning. Sensible defaults are built in."],
  },
  // --- apps/web/.env ---
  {
    id: "web",
    title: "Web app (build-time, public)",
    file: "web",
    always: true,
    comment: [
      "These are BUILD-TIME client vars — they are inlined into the browser",
      "bundle and are therefore public. Never put a secret here.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const ENV_VARS: EnvVar[] = [
  // --- core ----------------------------------------------------------------
  {
    key: "DATABASE_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "PostgreSQL connection string",
    hint: "e.g. postgresql://user:password@host:5432/dbname — or leave blank to omit and set it on the platform",
    example: "postgresql://postgres:password@localhost:5432/cockpit_context",
    exampleSet: true,
  },
  {
    key: "DATABASE_POOL_MAX",
    group: "core",
    source: "default",
    default: "10",
    advanced: true,
    comment: [
      "Max connections in this process's Postgres pool (node-postgres `max`).",
      "Default 10 matches the driver default — raise it only against the",
      "database's connection budget; the app and each standalone script hold their own pool.",
    ],
  },

  // --- runtime -------------------------------------------------------------
  {
    key: "MIGRATE_ON_START",
    group: "runtime",
    source: "default",
    default: "true",
    example: "true",
    comment: ["Read by the image entrypoint. Apply committed migrations before server startup."],
  },
  {
    key: "COCKPIT_CONTEXT_INSTANCE_ID",
    group: "runtime",
    source: "default",
    hidden: true,
    comment: ["Optional UUID generated by the image entrypoint for migration instance tracking."],
  },
  {
    key: "COCKPIT_CONTEXT_HTTP_PORT",
    group: "runtime",
    source: "default",
    default: "3000",
    example: "3000",
    comment: ["Host HTTP port (1-65535), read only by compose.vps.yaml."],
  },
  {
    key: "BACKUP_SCHEDULE",
    group: "backups",
    source: "default",
    default: "off",
    example: "off",
    choices: [{ value: "off" }, { value: "daily" }],
    comment: ["Set daily to take a verified dump every day in addition to pre-migration backups."],
  },
  {
    key: "BACKUP_HOUR_UTC",
    group: "backups",
    source: "default",
    hidden: true,
    default: "3",
    example: "3",
    comment: ["Hour (0-23, UTC) for the daily backup."],
  },
  {
    key: "BACKUP_KEEP",
    group: "backups",
    source: "default",
    hidden: true,
    default: "14",
    example: "14",
    comment: [
      "Days of daily dumps to retain (1-365), one per day. Expire off-site copies with a bucket lifecycle rule.",
    ],
  },

  {
    key: "NODE_ENV",
    group: "runtime",
    source: "default",
    default: "development",
    choices: [{ value: "production" }, { value: "development" }, { value: "test" }],
    example: "production",
    comment: [
      "Set to `production` on every deployed environment. Several env guards",
      "escalate from a warning to a hard boot failure when this is `production`",
      "— that is intentional, do not weaken it to silence a startup error.",
    ],
  },
  {
    key: "BACKUP_ENABLED",
    group: "backups",
    source: "default",
    default: "true",
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Enable the app's off-site backup freshness monitoring. This switch does",
      "not disable the daily or pre-migration dump writer.",
    ],
  },
  {
    key: "PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    comment: [
      "[server-only] Injected by most platforms. Leave unset unless you are",
      "running the container by hand.",
    ],
  },
  {
    key: "SERVER_PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "3000",
    defaultFrom: "app",
    comment: [
      "[server-only] Raw local runs (`pnpm dev:raw`) and container overrides",
      "only. Leave unset for the default portless dev flow — portless injects",
      "PORT per app. The schema field is optional with no Zod default; 3000 is",
      "the fallback in apps/server/src/index.ts.",
    ],
  },

  {
    key: "JOBS_CONCURRENCY",
    group: "runtime",
    source: "default",
    default: "2",
    advanced: true,
    comment: [
      "[server-only] Background jobs the in-process runner executes at once",
      "The runner lives in the app process;",
      "there is no separate worker.",
    ],
  },

  // --- auth ----------------------------------------------------------------
  {
    key: "BETTER_AUTH_SECRET",
    group: "auth",
    source: "generate",
    generator: "secret32",
    required: true,
    secret: true,
    comment: [
      "REQUIRED, minimum 32 characters. The env validator rejects weak and",
      "placeholder values in production. Rotating this invalidates every",
      "existing session — generate once per environment and keep it stable.",
      "",
      "For LOCAL dev this is filled in for you by `pnpm run setup`; to mint one",
      "by hand use `pnpm generate:secret` and paste it below. For a PRODUCTION",
      "environment prefer `pnpm generate:secrets`, which generates this along",
      "with the rest of the block and validates the result.",
    ],
  },
  {
    key: "BETTER_AUTH_URL",
    format: "origin",
    group: "auth",
    source: "prompt",
    required: true,
    prompt: "Public app origin (used by auth callbacks and for SEO URLs)",
    hint: "Origin only — no path, query, hash, or credentials. e.g. https://app.example.com",
    example: "https://cockpit-context.localhost",
    exampleSet: true,
  },
  {
    key: "CORS_ORIGIN",
    format: "origin",
    group: "auth",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional. Set ONLY when the browser app runs on a different origin than",
      "the API (raw web dev, split-origin deploys). Leave unset for",
      "the default same-origin flow. No path, query, or hash.",
    ],
  },
  {
    key: "TRUST_PROXY_HOPS",
    advanced: true,
    group: "auth",
    source: "manual",
    example: "1",
    comment: [
      "Number of reverse-proxy hops in front of the app, for deriving the real",
      "client IP used as the anonymous rate-limit key. LEAVE UNSET — the default",
      "auto-detects a client behind a private-network proxy (e.g. Dokploy/nginx)",
      "and keys on the socket peer otherwise. Set it only",
      "when a proxy in front of the app has a PUBLIC IP (e.g. Cloudflare): the",
      "exact hop count. 0 disables X-Forwarded-For entirely.",
    ],
  },

  // --- admin ---------------------------------------------------------------
  {
    key: "ADMIN_EMAILS",
    group: "admin",
    source: "prompt",
    required: true,
    prompt: "Admin email addresses (required on first boot; comma-separated)",
    hint: "Required on first boot: sign up with one of these addresses plus the one-time [bootstrap] token from the boot log to create the first admin. Closes once any account exists. Emails are trimmed and lowercased; existing admin roles persist in the database.",
    comment: [
      "REQUIRED on first boot. Sign up with a listed address and the one-time",
      "[bootstrap] token printed to the boot log to become the first admin.",
    ],

    example: "admin@example.com,other@example.com",
  },
  {
    key: "SIGNUP_ENABLED",
    group: "admin",
    source: "confirm",
    confirmDefault: false,
    prompt: "Enable public signup",
    hint: "Leave off for internal tools. With SMTP, signup requires email verification. Without SMTP, the server boots with a warning and creates accounts verified; password reset is unavailable.",
    default: "false",
    example: "false",
    comment: [
      "Public account creation is disabled by default. While no account exists,",
      "an ADMIN_EMAILS address with the boot-log token can create the first admin.",
      "With SMTP, signup requires email verification. Without SMTP, the app",
      "boots with a warning and accounts are created verified; password reset",
      "is unavailable. The signup form remains available.",
    ],
  },

  // --- Cockpit Context ----------------------------------------------------------------
  {
    key: "COCKPIT_CONTEXT_ENCRYPTION_KEYS",
    group: "cockpit-context",
    source: "generate",
    generator: "encryptionKeyring",
    required: true,
    secret: true,
    comment: [
      "REQUIRED in production. AES-256-GCM keyring for secrets at rest:",
      "`v1:<base64 32-byte key>`. To rotate, PREPEND a new version and keep the",
      "old entries (`v2:<new>,v1:<old>`): the first entry encrypts, all decrypt,",
      "and rows are re-encrypted lazily. `pnpm run setup` fills a local one;",
      "`pnpm generate:secrets` mints one for production.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_DATA_DIR",
    group: "cockpit-context",
    source: "default",
    default: "/data",
    defaultFrom: "app",
    example: "/data",
    comment: [
      "Absolute path for clones and checkouts. Unset: /data in production,",
      "<repo>/.data in development. A relative path resolves against the repo root.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_MAX_STORAGE_GB",
    group: "cockpit-context",
    source: "default",
    default: "20",
    example: "20",
    comment: [
      "Disk cap for clones + checkouts, in decimal GB (1 GB = 10^9 bytes). Above it,",
      "least-recently-used checkouts and then clones are pruned until usage is under",
      "90 % of the cap.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST",
    group: "cockpit-context",
    source: "default",
    default: "",
    advanced: true,
    hint: "Exact host names (comma-separated; no wildcards, ports or IPs) of internal git servers whose remotes may resolve to RFC 1918, CGNAT or IPv6 unique-local addresses. Loopback, link-local and cloud-metadata addresses stay refused. An SSRF trade-off: see docs/deploy.md.",
  },
  {
    key: "COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS",
    group: "cockpit-context",
    source: "default",
    default: "300",
    advanced: true,
    hint: "A branch or default-ref question fetches the remote only when the last fetch is older than this. Tags and commits never refetch once present.",
  },

  // --- agent ---------------------------------------------------------------
  {
    key: "OPENROUTER_API_KEY",
    group: "agent",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "OpenRouter API key",
    hint: "openrouter.ai → Keys. Also used by `pnpm i18n:translate` when TRANSLATION_PROVIDER=openrouter.",
    example: "",
  },
  {
    key: "COCKPIT_CONTEXT_MODEL",
    group: "agent",
    source: "prompt",
    required: true,
    prompt: "OpenRouter model id for the investigation agent",
    hint: "e.g. anthropic/claude-sonnet-4.5. Required whenever OPENROUTER_API_KEY is set.",
    example: "",
  },
  {
    key: "COCKPIT_CONTEXT_HELPER_MODEL",
    group: "agent",
    source: "prompt",
    prompt: "Model id for helper (delegate_explore) agents (blank = same as COCKPIT_CONTEXT_MODEL)",
    example: "",
  },
  {
    key: "COCKPIT_CONTEXT_MODEL_API",
    group: "agent",
    source: "default",
    default: "chat-completions",
    advanced: true,
    comment: [
      "The API the agent speaks to the model endpoint: chat-completions (OpenAI Chat",
      "Completions), responses (OpenAI Responses) or messages (Anthropic Messages).",
      "OpenRouter serves all three, with prompt caching on each. The local fake",
      "OpenRouter server speaks chat-completions only.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_OPENROUTER_BASE_URL",
    group: "agent",
    source: "manual",
    advanced: true,
    example: "http://localhost:4010/api/v1",
    comment: [
      "API root ending in /v1; leave unset to use OpenRouter (https://openrouter.ai/api/v1).",
      "Set it for the local fake OpenRouter server or an OpenRouter-compatible gateway.",
      "Production refuses a non-https value.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_MAX_ITERATIONS",
    group: "agent",
    source: "default",
    default: "100",
    advanced: true,
    hint: "Agent-loop iteration cap per main run; helper budgets scale from it.",
  },
  {
    key: "COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS",
    group: "agent",
    source: "default",
    default: "600",
    advanced: true,
    hint: "Wall-clock cap per run (and the checkout-lease length). The agent writes a final summary when it runs out.",
  },
  {
    key: "COCKPIT_CONTEXT_MODEL_STALL_SECONDS",
    group: "agent",
    source: "default",
    default: "90",
    advanced: true,
    hint: "Longest a model request may send nothing. Before the first token it is retried, then failed over; mid-answer the dispatch fails. 10 to 3600.",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS",
    group: "agent",
    source: "default",
    default: "4",
    advanced: true,
    hint: "Runs executing at once across all users; the rest queue in order.",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER",
    group: "agent",
    source: "default",
    default: "3",
    advanced: true,
    hint: "Runs executing at once for one user. Overview summary runs do not count (they count toward the global cap only).",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "Questions (main runs) one user may have waiting for a run slot at once, web and MCP together. Past it a new question is refused with BUSY. 0 = unlimited. Summary runs never count.",
  },
  {
    key: "COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED",
    group: "agent",
    source: "default",
    default: "true",
    hidden: true,
    hint: "Owner-scoped MCP answer reuse: identical concurrent query_dependency questions of one user share one investigation, and a completed answer is reused for the same user, commit, notes, overview override, question and model config. Never across users. false turns it off.",
  },
  {
    key: "COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS",
    group: "agent",
    source: "default",
    default: "3600",
    hidden: true,
    hint: "How long a completed MCP answer is reused for an identical question (seconds).",
  },
  {
    key: "COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES",
    group: "agent",
    source: "default",
    default: "500",
    hidden: true,
    hint: "Most reusable MCP answers kept in memory; the least recently used goes first.",
  },
  {
    key: "COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS",
    group: "agent",
    source: "default",
    default: "300",
    hidden: true,
    hint: "How long an exact version, tag or full commit resolution is reused (seconds), skipping the tag fetch and registry lookup. Branches always resolve afresh. 0 turns it off.",
  },
  {
    key: "COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES",
    group: "agent",
    source: "default",
    default: "1000",
    hidden: true,
    hint: "Most version resolutions kept in memory; the least recently used goes first.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_WAIT_SECONDS",
    group: "agent",
    source: "default",
    default: "900",
    advanced: true,
    hint: "Longest an MCP query_dependency/get_query_result call waits before returning `running`; also the cap on the caller's wait_seconds.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR",
    group: "agent",
    source: "default",
    default: "30",
    advanced: true,
    hint: "query_dependency calls one MCP credential (token or OAuth connection) may make per hour; each starts a model-spending run.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR",
    group: "agent",
    source: "default",
    default: "120",
    advanced: true,
    hint: "Cap on query_dependency calls per hour for one USER across all of their MCP tokens and OAuth connections (default 120). 0 = unlimited: only the per-credential COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR applies.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE",
    group: "agent",
    source: "default",
    default: "120",
    advanced: true,
    hint: "MCP tool calls of any kind one credential may make per minute.",
    comment: [
      "MCP tool calls of any kind one credential may make per minute.",
      "Every other Cockpit Context rate budget is a COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW> count",
      "(at least 1; no budget can be turned off). They are listed in",
      "Admin -> Settings.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_RUNS_PER_HOUR",
    group: "agent",
    source: "default",
    default: "60",
    hidden: true,
    hint: "Investigation runs one user may start per hour from the web (new conversations and follow-ups together). Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_STEERS_PER_10_MINUTES",
    group: "agent",
    source: "default",
    default: "120",
    hidden: true,
    hint: "Steering messages one user may send to their live runs per 10 minutes. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_SUMMARY_REGENERATIONS_PER_HOUR",
    group: "agent",
    source: "default",
    default: "10",
    hidden: true,
    hint: "Repository overview regenerations one user may request per hour (each is a model-spending run). Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_REPOSITORY_REFRESHES_PER_10_MINUTES",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "Manual repository refreshes (git fetch) one user may request per 10 minutes. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_REGISTRY_LOOKUPS_PER_5_MINUTES",
    group: "agent",
    source: "default",
    default: "60",
    hidden: true,
    hint: "Package registry lookups one user may make per 5 minutes. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "SSH host fingerprint scans one user may run per 10 minutes. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_SSH_KEY_WRITES_PER_HOUR",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "SSH keys one user may generate or import per hour. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_TOKEN_CREATIONS_PER_HOUR",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "MCP API tokens one user may create per hour. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_PACKAGE_WRITES_PER_10_MINUTES",
    group: "agent",
    source: "default",
    default: "60",
    hidden: true,
    hint: "Package saves that set a git URL (create, edit, approve a proposal) one user may make per 10 minutes. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_IP_REQUESTS_PER_MINUTE",
    group: "agent",
    source: "default",
    default: "120",
    hidden: true,
    hint: "Requests to /mcp before authentication, per client IP, per minute. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_CREDENTIAL_REQUESTS_PER_MINUTE",
    group: "agent",
    source: "default",
    default: "240",
    hidden: true,
    hint: "MCP protocol requests one verified credential may make per minute. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_OAUTH_REQUESTS_PER_MINUTE",
    group: "agent",
    source: "default",
    default: "120",
    hidden: true,
    hint: "MCP OAuth protocol requests (authorize, token, revoke, JWKS) per client IP, per minute. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_CONSENTS_PER_MINUTE",
    group: "agent",
    source: "default",
    default: "30",
    hidden: true,
    hint: "MCP OAuth consent submissions per signed-in user (else IP), per minute. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MCP_REGISTRATIONS_PER_HOUR",
    group: "agent",
    source: "default",
    default: "60",
    hidden: true,
    hint: "MCP OAuth dynamic client registrations for the WHOLE server per hour (each writes a row). Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER",
    group: "agent",
    source: "default",
    default: "100",
    hidden: true,
    hint: "Package proposals one user may have waiting for a decision at once (MCP propose_dependency refuses more with PROPOSAL_LIMIT). Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER",
    group: "agent",
    source: "default",
    default: "10",
    hidden: true,
    hint: "MCP get_query_result calls one user may have waiting at once; past it a call returns `running` at once instead of waiting. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER",
    group: "agent",
    source: "default",
    default: "20",
    hidden: true,
    hint: "Live web streams (conversation views and activity feeds together) one user may hold open at once. Whole number, at least 1.",
  },
  {
    key: "COCKPIT_CONTEXT_LSP_IDLE_SECONDS",
    group: "agent",
    source: "default",
    default: "30",
    advanced: true,
    hint: "Language servers stop after this much idle time.",
  },
  {
    key: "COCKPIT_CONTEXT_LSP_MAX_SERVERS",
    group: "agent",
    source: "default",
    default: "4",
    advanced: true,
    hint: "Language servers running at once; the least recently used is evicted. 0 disables the LSP tools.",
  },
  {
    key: "COCKPIT_CONTEXT_LSP_SANDBOX",
    group: "agent",
    source: "default",
    default: "required",
    advanced: true,
    hint: "required: language servers run in a Landlock sandbox that can read only the checkout and their own files (Linux 5.13+ with Landlock enabled; the image ships the helper), and without it the LSP tools are disabled. off: run them unsandboxed (development hosts only; logs a warning).",
  },

  // --- privacy -------------------------------------------------------------
  {
    key: "COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS",
    group: "privacy",
    source: "default",
    default: "90",
    example: "90",
    comment: [
      "Days after its last activity before a conversation, with its runs and",
      "turns, is deleted (checked daily). 0 keeps conversations until deleted.",
      "Conversations with a queued or running run are never deleted.",
    ],
  },
  {
    key: "COCKPIT_CONTEXT_OPERATOR_NAME",
    group: "privacy",
    source: "manual",
    example: "Example Co.",
    comment: ["Person or organization running this instance, shown on the privacy notice."],
  },
  {
    key: "COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL",
    group: "privacy",
    source: "manual",
    example: "privacy@example.com",
    comment: ["Address for privacy questions and requests, shown on the privacy notice."],
  },

  // --- smtp ----------------------------------------------------------------
  {
    key: "SMTP_HOST",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP host",
    hint: "e.g. smtp.resend.com, smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com",
    example: "localhost",
  },
  {
    key: "SMTP_PORT",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP port",
    hint: "587 for STARTTLS (most providers), 465 for implicit TLS, 1025 for a local mailpit sink",
    example: "1025",
  },
  {
    key: "SMTP_USER",
    group: "smtp",
    source: "prompt",
    prompt: "SMTP username (blank if your provider doesn't require auth)",
    example: "",
  },
  {
    key: "SMTP_PASS",
    group: "smtp",
    source: "prompt",
    secret: true,
    prompt: "SMTP password / API key (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_FROM",
    group: "smtp",
    source: "prompt",
    required: true,
    // Excluded from the group's reuse offer: this is the app's own From:
    // identity, so inheriting it sends the new app's mail branded as the old.
    reusable: false,
    prompt: "From: address for outgoing mail",
    hint: 'e.g. "App Name <no-reply@yourdomain.com>". Required whenever SMTP_HOST is set.',
    example: "noreply@example.com",
  },

  // --- sso -----------------------------------------------------------------
  {
    key: "SSO_ENABLED",
    group: "sso",
    // Flipped to true automatically when the SSO group is enabled — credentials
    // alone do not turn SSO on (packages/auth gates on this flag).
    source: "enable",
    default: "false",
    example: "true",
  },
  {
    key: "SSO_CLIENT_ID",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO client ID",
    example: "",
  },
  {
    key: "SSO_CLIENT_SECRET",
    group: "sso",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "SSO client secret",
    example: "",
  },
  {
    key: "SSO_ISSUER",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO issuer URL",
    hint: "e.g. https://your-org.okta.com",
    example: "https://your-org.okta.com",
  },
  {
    key: "SSO_PROVIDER_NAME",
    group: "sso",
    source: "prompt",
    default: "SSO",
    prompt: "SSO provider display name (shown on the login button)",
    hint: 'e.g. "Okta", "Entra ID", "Google Workspace"',
    example: "Okta",
  },
  {
    key: "FORCE_SSO",
    advanced: true,
    group: "sso",
    source: "default",
    default: "false",
    example: "false",
    comment: [
      "true disables password login entirely. In production this requires",
      "SSO_ENABLED plus all three SSO credentials or the server throws at boot.",
    ],
  },

  // --- backups -------------------------------------------------------------
  {
    // A compose variable, not an app one: compose reads it from this file and
    // starts the db-backup service (compose.yaml). The only compose-only key
    // in this manifest, listed so the backup switch sits next to its settings.
    key: "COMPOSE_PROFILES",
    group: "backups",
    source: "manual",
    inSchema: false,
    example: "db-backup",
    comment: [
      "docker compose only: db-backup starts the S3 backup service. Set it",
      "once the bucket and dump-writer keys below are filled in (the service",
      "refuses to start without them and would restart in a loop).",
    ],
  },
  {
    key: "BACKUP_S3_BUCKET",
    group: "backups",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "Backup bucket name",
    hint: "Private bucket for pg_dump custom-format dumps. Prefer a dedicated bucket, not the app-assets bucket.",
    example: "",
  },
  {
    key: "BACKUP_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 access key ID",
    hint: "Required for dump writers. Must be a dedicated GetObject/PutObject/AbortMultipartUpload key.",
    example: "",
  },
  {
    key: "BACKUP_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 access key ID",
    hint: "ListBucket-only key for the app's freshness check; never reuse the dump read/write key.",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_S3_REGION",
    group: "backups",
    source: "prompt",
    default: "auto",
    prompt: "Backup S3 region",
    hint: '"auto" for Cloudflare R2; a real region for AWS S3',
    example: "auto",
  },
  {
    key: "BACKUP_S3_ENDPOINT",
    group: "backups",
    source: "prompt",
    prompt: "Backup S3 endpoint URL (blank for AWS S3; required for R2/MinIO/B2/Spaces)",
    example: "",
  },
  {
    key: "BACKUP_S3_PREFIX",
    group: "backups",
    source: "default",
    default: "cockpit-context/prod/database",
    example: "cockpit-context/prod/database",
    comment: [
      "Dumps land under the configured prefix. Scope both keys'",
      "IAM policies and the bucket lifecycle rules to this prefix.",
    ],
  },
  {
    key: "BACKUP_S3_FORCE_PATH_STYLE",
    hidden: true,
    group: "backups",
    source: "default",
    default: "false",
    example: "false",
  },
  {
    key: "BACKUP_S3_SSE",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Leave empty for R2 and most S3-compatible providers. Set to AES256 only",
      "for AWS S3 when you want SSE-S3 on backup objects.",
    ],
  },
  {
    key: "BACKUP_MAX_AGE_HOURS",
    group: "backups",
    source: "default",
    default: "36",
    example: "36",
    comment: [
      "Backup freshness check (app background job, every 6h): alert admins and flag the",
      "admin dashboard when the newest dump in BACKUP_S3_BUCKET is older than",
      "this many hours. 36 tolerates one missed nightly run; two always alert.",
    ],
  },

  // --- translation ---------------------------------------------------------
  {
    key: "PUBLIC_APP_URL",
    hidden: true,
    format: "origin",
    group: "translation",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional origin metadata sent to translation providers such as",
      "OpenRouter. Not used for auth — it is declared in the shared schema.",
    ],
  },
  {
    key: "TRANSLATION_PROVIDER",
    group: "translation",
    source: "prompt",
    default: "openrouter",
    prompt: "Translation provider",
    choices: [
      {
        value: "openrouter",
        label: "OpenRouter (default)",
        description: "Cheapest path to claude-haiku-4-5, plus multi-model access from one account",
      },
      {
        value: "anthropic",
        label: "Anthropic direct",
        description: "Calls the Anthropic API directly with ANTHROPIC_API_KEY",
      },
    ],
    example: "openrouter",
  },
  {
    key: "ANTHROPIC_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "Anthropic API key (blank if using openrouter)",
    hint: "Required when TRANSLATION_PROVIDER=anthropic",
    example: "",
  },
  {
    key: "TRANSLATION_MODEL",
    hidden: true,
    group: "translation",
    source: "manual",
    example: "anthropic/claude-haiku-4-5",
    comment: [
      "Per-call model override. Defaults to `anthropic/claude-haiku-4-5`",
      "(OpenRouter) or `claude-haiku-4-5` (Anthropic direct) when unset.",
    ],
  },

  // --- ratelimit (tuning) --------------------------------------------------
  // Three named budgets, two knobs per family.
  // Family-scaling semantics: a budget describes its family's
  // REFERENCE member; every other member keeps its ratio to that reference,
  // so POINTS multiplies every member's points by (provided/reference) and
  // WINDOW_SECONDS multiplies every member's window AND block duration by the
  // same factor. Burst/sustained ratios, bucket keying, and fail-open vs
  // fail-closed stay fixed in code (packages/api/src/lib/rate-limit-families.ts
  // + apps/server/src/rate-limit.ts). Tighter is not safer — if one surface
  // 429s legitimate users, split the surface instead of shrinking a budget.
  // Default budgets are defined in the rate-limit family modules.
  {
    key: "RATE_LIMIT_AUTH_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "30",
    hint: "Auth family reference: requests per IP per window on the general /api/auth/* surface (password reset, verification, session ops). Setting it rescales the whole fail-closed auth family at each member's designed ratio: credential 10, credential-burst 3/10s, signup 10/h, 2FA-OTP 3/15min.",
  },
  {
    key: "RATE_LIMIT_AUTH_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the auth family reference. Scales every auth-family window AND block duration by the same factor.",
  },
  {
    key: "RATE_LIMIT_RPC_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "100",
    hint: "RPC family reference: requests per user (per IP signed out) per window on /rpc/*. /ready (60) and the SSR catch-all (300) scale with it. One batched request can carry up to ORPC_BATCH_MAX_SIZE procedures.",
  },
  {
    key: "RATE_LIMIT_RPC_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the RPC family reference; scales /ready and SSR with it.",
  },
  {
    key: "RATE_LIMIT_EMAIL_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3",
    hint: "Email family reference: mails per RECIPIENT per window on the anonymous send-mail endpoints (verification resend, password reset). Signup (6) and sign-in-triggered mails (10) scale with it. Keyed on the mailbox, so rotating IPs cannot flood one inbox. 0 disables the whole recipient family.",
  },
  {
    key: "RATE_LIMIT_EMAIL_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3600",
    hint: "Window (seconds) for the email family reference; scales all three recipient buckets with it.",
  },

  // --- limits (tuning) -----------------------------------------------------
  {
    key: "SSR_CACHE_TTL_SECONDS",
    advanced: true,
    group: "limits",
    source: "default",
    default: "60",
    comment: [
      "In-memory SSR HTML cache for anonymous GETs of public routes. 0 disables",
      "it. Public content edits can take up to this long to appear live.",
    ],
  },

  // --- apps/web/.env -------------------------------------------------------
  {
    key: "VITE_APP_NAME",
    group: "web",
    file: "web",
    source: "default",
    default: "Cockpit Context",
    // Not a Zod default: web.ts declares this `.optional()` and applies "Cockpit Context"
    // through a getter on the exported env object.
    defaultFrom: "app",
    example: "Cockpit Context",
    comment: ["Used in the app shell title/header."],
  },
  {
    key: "VITE_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
    comment: [
      "API origin. Defaults to window.location.origin at runtime — leave unset",
      "for the portless/Vite proxy flow. No path, query string, or hash.",
    ],
  },
  {
    key: "VITE_DEV_PORT",
    group: "web",
    file: "web",
    source: "manual",
    example: "3001",
    comment: [
      "Raw dev-server knobs. Leave unset with portless, which assigns ports and",
      "proxies /api, /rpc, /sw, /ws. Without portless, Vite listens on",
      "3001 and proxies to 3000.",
    ],
  },
  {
    key: "VITE_DEV_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function groupsForFile(file: EnvFile): EnvGroup[] {
  return ENV_GROUPS.filter((g) => (g.file ?? "root") === file);
}

export function varsInGroup(groupId: string): EnvVar[] {
  return ENV_VARS.filter((v) => v.group === groupId);
}
