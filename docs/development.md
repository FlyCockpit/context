# Development conventions

Use Node.js 26.13.1 and repository-pinned pnpm 12. Install pnpm with the SHA-512-verifying installer; Node 26 does not supply Corepack. Install Docker/Podman and user-managed `portless` for local HTTPS.

```sh
node scripts/install-pnpm.mjs package.json "$HOME/.local/bin" "$HOME/.local/share/cockpit-context"
export PATH="$HOME/.local/bin:$PATH"
pnpm install
pnpm setup:app
pnpm dev
```

Setup is idempotent and prepares missing local env files/secrets, bootstrap admin address and local services/migrations. It does not provide a real model API key. Set `OPENROUTER_API_KEY` and `COCKPIT_CONTEXT_MODEL` privately. Use the configured local HTTPS origin, sign up with the bootstrap address and the `[bootstrap]` token the server prints at startup, verify through development Mailpit if configured, and enroll 2FA. `pnpm dev:raw` uses web port 3001; see [local MCP](./mcp.md#local-development).

## Change workflow

Read [AGENTS.md](../AGENTS.md), [product](./product.md) and [access matrix](./access-matrix.md). Keep PRs focused, explain behavior and limits, and report actual validation. Prefer existing components and procedures. Update permission documentation alongside live bindings. Public routes update server PUBLIC_PATHS and [sitemap](../sitemap.md).

Use oRPC query/mutation/infinite options, bounded cursor pagination, native Zod with TanStack Form and shared field/overlay components. Localized UI strings use `t()`; add en-US keys then run `pnpm i18n:translate`. Preserve loaded list data on transient fetch errors. React routes export only Route and types; use audited hooks rather than component effects. Keep one bounded main scroller per layout and use router navigation for internal links. See AGENTS for the full web shell contract.

New env vars require schema and manifest edits followed by `pnpm env:sync`. Generated route trees, agent mirrors, env examples and lockfile are not hand-edited. New dependencies need prior agreement and shared versions belong in the pnpm catalog. Do not weaken auth, CSP, rate limits or checks to resolve a failure.

## Validation

Run `pnpm verify:fast` before handoff; full `pnpm verify` runs in CI/release, and template/tooling self-tests run through `pnpm verify:tooling`. `pnpm verify:fast` runs the root script suites (`db:test-unit`, `backup:test-unit`, `deploy:test-unit`) only when the branch or the work tree changes something they read (`scripts/test-scripts-affected.ts`); a path its rules do not name, a shared input or an unknown base runs all three, and `pnpm verify` and CI always run them. Use focused Vitest tests for risky changed behavior, mocking database and import-time IO; unit tests never hit a real database. Use disposable Postgres only for explicit migration integration checks. Run `pnpm docs:check-citations`, `node scripts/check-agents-size.ts` and `node scripts/check-agent-rules.ts` for documentation/rule changes.

The Docker test harnesses (`pnpm backup:test`, `pnpm db:test-migrations`, `pnpm runtime:test-operations`) name every container, network and throwaway image they create under one prefix: `--container-prefix <name>` wins, else `TEST_CONTAINER_PREFIX`, else each harness's own default. A chained or shared-machine run sets `TEST_CONTAINER_PREFIX` once; an empty or invalid value is an error. `backup:test` also publishes its server on `BACKUP_TEST_PG_PORT` (default 55432), so a parallel run needs its own port.

After editing AGENTS run `pnpm sync:agent-docs`. UI error diagnostics from React Doctor block CI. Never bypass pre-commit hooks or disable a failing policy gate. Include unresolved failures and missing integration evidence in your PR.

## Local databases

Each checkout has its own local database (`pnpm db:worktree`). `pnpm db:reset:local` rebuilds only that exact name on localhost, refuses `EXPECTED_DB`, and drops only a database carrying the disposable-local mark that `pnpm db:worktree` or a fresh dev compose volume writes. A person adopts an older local database once with `pnpm db:worktree --adopt` (interactive terminal, typed confirmation); agents never run it, never write the mark (`COMMENT ON DATABASE`), and never run a raw `prisma migrate resolve`. The Claude hook denies the direct spellings of all three; it is defence in depth, not a guarantee (it cannot read SQL in a file passed to `psql -f` or piped from one). `pnpm db:migrate:apply` refuses, changing nothing, while another session holds the migration runner lock or Prisma's lock. See [schema-changes-recipe § Local database troubleshooting](./schema-changes-recipe.md#local-database-troubleshooting).

## Schema conventions

Use the [migration workflow](./schema-migrations.md) and [change recipe](./schema-changes-recipe.md). Projections are disclosure boundaries: typed Prisma selects, no result casts that conceal over-disclosure. Monetary values are integer minor units; public slugs are human-readable. Models need stable IDs/timestamps and indexed ownership/foreign-key relations. Use mapped database names for renames and two releases for type transitions.

## Writing about dangerous commands

A display-only mention is not an invocation. `destructive:audited` marks proven-inert documentation/test text; it never authorizes executing destructive commands or exempts an entire file. Executable exceptions are exact path/line-hash/count entries in `scripts/policy-checks.sh`, independently reviewed against AGENTS. Keep command-boundary deny rules in `scripts/claude-hooks/pre-tool-use.mjs` and agent rules aligned. On harnesses without that hook, retain sandbox/approval controls and use focused reviewed diffs; never treat absent enforcement as permission.

## Security and recovery

Never paste secrets, private source, prompts, conversations or filled env files into public issues. Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md). Operator configuration and first signup are in [deployment](./deploy.md); data/key custody and explicit restore confirmation are in [backup/restore](./backup-restore.md). Auth and permissions are security boundaries even in tests and examples.

## Password pepper

Password hashes use Better-Auth's scrypt, sealed with AES-256-GCM under a key derived from `BETTER_AUTH_SECRET` with HKDF-SHA256. A database dump, backup, or read-only SQL injection no longer yields crackable hashes without the server secret. A full server compromise with that secret is outside this protection.

Stored format: `pw1:<16-hex key fingerprint>:<base64url(nonce || ciphertext || tag)>`. The fingerprint identifies the key without revealing it. The authenticated additional data (AAD) is `password-v1`. Better-Auth's password hooks receive no user id, so values are not bound to their row. A database writer can still swap two accounts' values.

The server seals legacy unsealed hashes and authenticates every sealed value at startup, in one transaction under an advisory lock, before listening. Sign-in never accepts unsealed hashes. Corrupt values produce a startup warning with a count and the recovery command; startup still succeeds when no unknown keys remain. `pnpm doctor:app` reports fingerprints, counts, and structurally invalid envelopes without changing data. It does not receive the key in its database probe; cryptographic authenticity is checked at server start.

To rotate the secret:

1. Stop the server. Set `BETTER_AUTH_SECRET_PREVIOUS=<old>` and `BETTER_AUTH_SECRET=<new>` for the server, then restart it. Both secrets must be strong, at least 32 characters, and different. Never run instances with different `BETTER_AUTH_SECRET` configurations side by side: an old-config replica can neither verify re-wrapped hashes nor write current-key ones.
2. Check that the log `password pepper: re-wrapped … none remain under the previous key … BETTER_AUTH_SECRET_PREVIOUS can now be removed` or `pnpm doctor:app` shows 0 remaining under the previous key. Resolve doctor's invalid-envelope warnings before relying on its fingerprint inventory. If hashes remain, keep PREVIOUS set and restart the server again. If they are corrupt, use the recovery command below.
3. Only after 0 remain, remove `BETTER_AUTH_SECRET_PREVIOUS` everywhere and restart the server again.

Rotating `BETTER_AUTH_SECRET` still signs everyone out and makes existing TOTP enrolments undecryptable and invalidates MCP agent tokens, as before. The previous key applies only to the password pepper; it does not change those behaviours.

A `PasswordPepperKeyError` refuses startup when stored values name an unconfigured key. Restore the secret used to write them, as `BETTER_AUTH_SECRET` or as `BETTER_AUTH_SECRET_PREVIOUS` during rotation. The message names fingerprints, never secrets.

If the key is lost, or values are corrupt or malformed, the owner stops the server and runs recovery as a one-shot from a checkout with the validated server environment and database access. It needs no listening server:

```bash
pnpm auth:pepper:reset-unusable                     # dry run: count and affected user ids
pnpm auth:pepper:reset-unusable --confirm <count>   # exact count from the dry run
```

For production or any non-local database, add `--allow-non-local` to both commands, with the server stopped. The command uses the same local database guard as maintenance scripts by default. It replaces only unusable password values with random passwords nobody knows, sealed under the current key. It keeps credential rows, legacy hashes, and authentic current/previous values. Start the server, then tell the listed users to use the normal forgot-password email flow. SMTP must work for that flow. Without SMTP, an administrator can issue a password link for non-admin users from Admin → Users; recovering an admin requires working SMTP.

**Backups:** `BETTER_AUTH_SECRET` also protects passwords. Back it up separately from the database and retain keys needed by older backups. A lost key requires the recovery procedure above for affected passwords. See [backup and restore](./backup-restore.md).


## Forced two-factor authentication

Administrator access requires a second factor by default. Preserve FORCE_2FA_DEFAULTS, the 24-hour enrollment grace and createdAt in session projections/call sites. Do not lengthen the grace, change the absent-setting default or apply the grace to other authorization checks. MCP tokens/grants remain independently revocable credentials; their requests do not perform interactive second-factor enrollment.

## Query cache follows identity

The TanStack Query cache, Zustand stores, module state and every in-flight request callback belong to one identity: the one the document was used by. `apps/web/src/lib/document-identity.ts` keeps it at module scope for the document's whole life (never in a component, which a public page or an error reset would unmount and make forget). When a confirmed identity differs from it, the document is replaced with a full load. Every replacement first quarantines the document synchronously: the page is hidden and the QueryClient sealed (emptied, and anything a late callback adds is removed again), so nothing of the previous identity stays on screen while the new page loads. The page is hidden with `display: none !important` on the root (CSSOM), which no descendant can undo (`visibility: hidden` could be, by any element that sets itself `visible`).

The chrome shows no account before a guard has admitted one. `_app`'s pending component, and the layout itself until the first load resolves (it paints the real shell around a skeleton while the guard runs), render under `SessionUnconfirmed` (`apps/web/src/lib/session-unconfirmed.ts`), where `useAuthSession()` reports `pending` whatever Better Auth's atom holds: a document entering the app from a public page can still hold the previous account's session there. The same holds after another tab announced a change (or a request got a 401) while no watcher was mounted to check it: the identity is marked unverified (generation-counted), and `useAuthSession()` reports `pending` everywhere until a fresh check confirms this document's identity or replaces the document: a guard's server answer, or a refetch the watcher itself starts when the shell mounts (retried on focus, visibility and reconnect while unverified; a check superseded by another session fetch is followed up at most 3 times, 250 ms apart; all of it dropped on unmount). An answer asked for before a newer invalidation never counts (a guard whose probe was overtaken by one asks again, up to twice, then shows its retryable error state, so no page renders on an answer that predates a sign-out elsewhere), and only a settled, successful answer (or a 401) counts as one (`readSessionIdentity()`), so a guard error or an unguarded page (`mcp-login`, `verify-email`) never shows the stale account either. The watcher reads the session unmasked (`useAuthSession({ unmasked: true })`) to see the answer that settles it; only the watcher reads it that way.

| Transition | What happens |
|---|---|
| Explicit sign-out (account menu, the MCP login page's "use another account") | `signOutAndLeave()` (`apps/web/src/lib/explicit-sign-out.ts`): marks the sign-out, then on success `leaveDocument()` to a fresh document with an empty cache (login, or the MCP login page with its signed query). A failure, returned or thrown, undoes the mark and is shown. Add any new sign-out button through it. |
| Signed out elsewhere (another tab, expiry, revocation, ban) | The document reloads in place; the guards send the visitor to login. |
| Another account (same tab or another tab) | The document reloads in place; the guards admit the new account and its queries load fresh. |
| Anonymous → signed in | Public pages update. Peer sign-in on login/signup/forgot/reset replaces the anonymous-only document; local sign-in keeps its navigation. |
| `pending` / `error` | Never acted on: a flaky session check must not reload a signed-in page. |

Three observers feed it, and none can be skipped:

- **Every session guard** (`_auth`, `admin`, `login`, `signup`, `forgot-password`, `reset-password`, `mcp-consent`) calls `resolveRouteSession()` (`apps/web/src/lib/route-session.ts`): `getRouteSession()`, then the identity check. A different identity replaces the document and the guard never settles, so no page renders the previous identity's cached data, even for a switch made while no `_app` page was open. `pnpm policy:checks` rejects any route-file reference to `getRouteSession` or `@/server/auth-session`.
- **Guards wait for the shell to hydrate.** On a hard refresh the server sends `_app`'s pending shell, and React hydrates it in a later low-priority pass, but the router runs the guards as soon as the outer tree commits. A redirect that lands before the shell hydrated makes React hydrate the shell for the new URL against the old URL's HTML: React error #418 (a signed-out cold load of `/settings`, a signed-in one of `/signup`). So `resolveRouteSession()` waits for `appShellHydrated()` (`apps/web/src/lib/app-shell-hydration.ts`) in parallel with its probe, whatever the guard then decides (redirect, not-found, error). `AppShellFrame` (`_app/route.tsx`) carries `data-app-shell` and reports from its mount effect. The wait applies only while a server-rendered shell is in the document and has not reported: never on the server or on a client navigation, and capped at 5 s.
- **The `_app` shell's watcher**, `useReloadOnIdentityChange()`, for a change while a page is open (a layout effect, before a frame pairs the new chrome with the old data). It also connects the open tabs: Better Auth tells other tabs about a sign-out but not a sign-in, so every session change made in a tab (Better Auth's session signal, in `lib/auth-client.ts`) and every newly confirmed identity is announced on the document's `BroadcastChannel`, and every other tab with a watcher re-checks its session. SSO returns through the login guard, which confirms the new identity before forwarding.
- **The global error toasts and the live subscriptions**: before any opt-out, a query rejected with 401 asks Better Auth to check the session (one check in flight at a time) instead of toasting; a mutation still toasts. A live subscription (`lib/stream-reconnect.ts`: `conversations.watch`, `conversations.activity`) rejected with 401 queues the same check. Nothing toasts once the document is being replaced.

Anonymous stays anonymous across refetches. Better Auth marks every request of an empty session `isPending` again (a refocus included), which looks the same as the first load. Once a document has settled `anonymous`, `useAuthSession` (`apps/web/src/hooks/use-auth-session.ts`) keeps it `anonymous` while Better Auth refetches and through a failed refetch; a confirmed session replaces it as usual. The memory is document-wide because the session atom is. So only the first load shows a skeleton (auth pages, the header's account control), apart from the identity masks above, and a refocus never unmounts the sign-in form or clears what was typed (`apps/web/src/components/auth/auth-form-refocus.test.tsx`).

The router also covers the back/forward cache: a document that ever held a signed-in user's state is hidden as it enters the cache and reloaded when restored, so Back never shows a frozen page nobody re-checked. Anonymous pages are cached as usual.

Why a full load, not `queryClient.clear()` or a fresh `QueryClient`: clearing the cache under mounted observers can leave a page stuck on a skeleton, `resetQueries()` refetches active queries as the wrong identity, and neither stops an in-flight mutation whose late `onSuccess` writes the old identity's data back; a swapped client still leaves Zustand stores and module state behind. A full load drops all of it. Persisted browser storage survives a load, so it holds no private data: the sidebar state and the device locale are not personal, and the getting-started "hidden" flag is keyed by user id (`lib/getting-started.ts`). Keep it that way, or scope new persisted state to the user.

The router opens the document's existing peer channel on public-only pages and
404s as well. It loads the session verifier lazily after a peer event; an ordinary
public load makes no session probe. When no app watcher is mounted, the verifier
uses the same session atom, coordinator and retry scheduler. A successful retry
still reconciles the document owner if the app mounts while that retry is pending.

Generic error recovery reruns route guards with `invalidate({ forcePending: true })`.
Successful parent matches stay pending before a child render boundary recovers,
so a previous private route context cannot remount before fresh admission.

The oRPC interceptor reports the first decoded private 401, including errors
inside a batch, before query retries or final cache callbacks. It invalidates
answers requested before that rejection and coalesces the same decoded error and
concurrent failures into one fresh session verification. That verification alone
uses `disableCookieCache`; ordinary session requests keep the existing 60-second
cookie cache. A failed verification keeps the targeted bypass and honors
`Retry-After`. Queries do not retry 401s; unrelated errors retain their normal
retry policy. A 403 does not trigger identity reconciliation. Live subscription
rejections share this same coordinator.

### Expected identity and session availability

Document-owned requests carry `X-Expected-User` from the document baseline. oRPC
uses `fetchWithExpectedIdentity`; use that same transport for future raw cookie
writes. The app has no upload surface. The `/rpc/*` middleware compares the raw
cookie owner after rate limiting; Better Auth compares it in `hooks.before`,
reusing the existing authoritative live-session check before policy filtering or
password-reset side effects. A mismatch returns `409 {code:"IDENTITY_CHANGED"}`.
The client quarantines and replaces the document before any toast or form callback.
Get-session and explicit sign-out are exempt. This consistency check grants no access.

The header offers Account unavailable, Retry and Sign out on a failed session
check. `session-retry.ts` shares one coordinator across mounted consumers and
native Better Auth refreshes: 2–60 second exponential backoff, honoring
`Retry-After` (exposed through CORS), paused hidden/offline. Native focus refresh
is disabled; the watcher owns focus, visibility and reconnect checks. A failed
sign-out while offline says the session remains signed in and to retry online.
Peer confirmations carry `{kind:"identity", id}`: matching identities cost no
check, conflicting confirmations and session-change hints coalesce. Only a fresh
server answer settles the identity; delayed announcements cannot establish it.

Admin role promotions and demotions require a named confirmation. Role demotion,
archive and deletion's initial access-removing ban use `withAdminRemovalGuard`:
target read, verified active admin count and write share a Serializable transaction.
Expired bans count as active; pending unverified invites do not. Conflicts require
manual retry. Repository cleanup follows the committed ban, outside the transaction,
so a cleanup failure leaves access blocked and deletion retryable. Successful role
changes use the existing structured admin audit log; same-role requests emit none.
Better Auth's parallel role/ban/remove and access-field update paths are blocked;
the UI uses oRPC. Ordinary profile updates retain the existing strict admin gate.
