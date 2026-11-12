# Development conventions

Use Node.js 26.13.1 and repository-pinned pnpm 12. Install pnpm with the SHA-512-verifying installer; Node 26 does not supply Corepack. Install Docker/Podman and user-managed `portless` for local HTTPS.

```sh
node scripts/install-pnpm.mjs package.json "$HOME/.local/bin" "$HOME/.local/share/cockpit-context"
export PATH="$HOME/.local/bin:$PATH"
pnpm install
pnpm run setup
pnpm dev
```

Setup is idempotent and prepares missing local env files/secrets, bootstrap admin address and local services/migrations. It does not provide a real model API key. Set `OPENROUTER_API_KEY` and `COCKPIT_CONTEXT_MODEL` privately. Use the configured local HTTPS origin, sign up with the bootstrap address and the `[bootstrap]` token the server prints at startup, verify through development Mailpit if configured, and enroll 2FA. `pnpm dev:raw` uses web port 3001; see [local MCP](./mcp.md#local-development).

## Change workflow

Read [AGENTS.md](../AGENTS.md), [product](./product.md) and [access matrix](./access-matrix.md). Keep PRs focused, explain behavior and limits, and report actual validation. Prefer existing components and procedures. Update permission documentation alongside live bindings. Public routes update server PUBLIC_PATHS and [sitemap](../sitemap.md).

Use oRPC query/mutation/infinite options, bounded cursor pagination, native Zod with TanStack Form and shared field/overlay components. Localized UI strings use `t()`; add en-US keys then run `pnpm i18n:translate`. Preserve loaded list data on transient fetch errors. React routes export only Route and types; use audited hooks rather than component effects. Keep one bounded main scroller per layout and use router navigation for internal links. See AGENTS for the full web shell contract.

New env vars require schema and manifest edits followed by `pnpm env:sync`. Generated route trees, agent mirrors, env examples and lockfile are not hand-edited. New dependencies need prior agreement and shared versions belong in the pnpm catalog. Do not weaken auth, CSP, rate limits or checks to resolve a failure.

## Validation

Run `pnpm verify:fast` before handoff; full `pnpm verify` runs in CI/release, and template/tooling self-tests run through `pnpm verify:tooling`. Use focused Vitest tests for risky changed behavior, mocking database and import-time IO; unit tests never hit a real database. Use disposable Postgres only for explicit migration integration checks. Run `pnpm docs:check-citations`, `node scripts/check-agents-size.ts` and `node scripts/check-agent-rules.ts` for documentation/rule changes.

After editing AGENTS run `pnpm sync:agent-docs`. UI error diagnostics from React Doctor block CI. Never bypass pre-commit hooks or disable a failing policy gate. Include unresolved failures and missing integration evidence in your PR.

## Schema conventions

Use the [migration workflow](./schema-migrations.md) and [change recipe](./schema-changes-recipe.md). Projections are disclosure boundaries: typed Prisma selects, no result casts that conceal over-disclosure. Monetary values are integer minor units; public slugs are human-readable. Models need stable IDs/timestamps and indexed ownership/foreign-key relations. Use mapped database names for renames and two releases for type transitions.

## Writing about dangerous commands

A display-only mention is not an invocation. `destructive:audited` marks proven-inert documentation/test text; it never authorizes executing destructive commands or exempts an entire file. Executable exceptions are exact path/line-hash/count entries in `scripts/policy-checks.sh`, independently reviewed against AGENTS. Keep command-boundary deny rules in `scripts/claude-hooks/pre-tool-use.mjs` and agent rules aligned. On harnesses without that hook, retain sandbox/approval controls and use focused reviewed diffs; never treat absent enforcement as permission.

## Security and recovery

Never paste secrets, private source, prompts, conversations or filled env files into public issues. Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md). Operator configuration and first signup are in [deployment](./deploy.md); data/key custody and explicit restore confirmation are in [backup/restore](./backup-restore.md). Auth and permissions are security boundaries even in tests and examples.

## Forced two-factor authentication

Administrator access requires a second factor by default. Preserve FORCE_2FA_DEFAULTS, the 24-hour enrollment grace and createdAt in session projections/call sites. Do not lengthen the grace, change the absent-setting default or apply the grace to other authorization checks. MCP tokens/grants remain independently revocable credentials; their requests do not perform interactive second-factor enrollment.
