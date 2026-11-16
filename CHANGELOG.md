# Changelog

All notable changes are documented here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Source-grounded dependency investigations over MCP at requested package versions or Git refs.
- Web management of packages, proposals, repository checkouts and live conversations, with steering, stop and follow-ups.
- OAuth and revocable per-user API tokens, private SSH dependencies and one-time-key snapshots.
- Confined search/read and sandboxed TypeScript/JavaScript and Python language-server tools, bounded runs and cache pruning.
- Single-container application with PostgreSQL metadata, in-process jobs, administrator controls, committed schema migrations and database backup/restore tooling.
- MCP `query_dependency` and `get_query_result` results report the finished query's model spend as `usage` (`cost_usd_micros`, `priced`, input, output and cached input tokens, `model`), summed over the main run and its helper runs. An unpriced model call makes the cost unknown (`priced: false`, `cost_usd_micros: null`), never 0; runs record unpriced calls in `agent_run.unpricedCalls`, and a model call that fails after reporting usage keeps its tokens. The dashboard's conversation header and list rows mark such a cost as a lower bound (`≥ $0.04, some calls unpriced`) or unknown, never as a plain total. A reused result reports zero new spend in `usage` and the shared investigation's spend in `original_usage`; callers count a query's `usage` once per `query_id` ([docs/mcp.md](./docs/mcp.md#query-cost)).

### Changed

- Backups are now opt-in with `BACKUP_ENABLED=true`. `TRUST_PROXY_HOPS` now defaults to `0`; set `1` behind Traefik, Dokploy or Caddy.
- `BACKUP_ENABLED=true` now needs a usable destination: a migrating start fails without one, a brand-new database too. The runner takes the pre-migration and pre-drop dumps in required mode.
- The image entrypoint is PID 1 while it migrates, forwards stop signals to the startup check and the migration runner (exit 143/130/129), then drops the backup writer keys and execs `tini` with the server.
- Restore: every refusal, usage error, cancel or signal before the restore transaction exits 3 (`REFUSED:`); a restore that started and provably rolled back exits 4 (`ROLLED BACK:`: COMMIT never sent, psql stopped on an SQL error before the confirmation that follows COMMIT, or the server reports the transaction aborted); exit 1 now means uncertain, or committed and then failed; a restore counts as complete only when its COMMIT is confirmed; archives with large objects are refused. `host.sh` restarts the app only after exit 3 or 4 (nothing changed); after a completed restore (0) it leaves it stopped and prints the next steps (`/data` snapshot clones, keyring check, then the start command), and after any other status it leaves it stopped and prints the start command; declining or interrupting its stop prompt exits 3; `restore | tee` works and keeps the exit status. `host.sh` stops before running anything when the app container's image ID is gone after a redeploy, and prints the `docker compose … up -d --no-build --force-recreate app` fix.
- Local dev: `pnpm db:reset:local` refuses databases without the disposable-local mark (adopt an existing dev database once with `pnpm db:worktree --adopt`); `pnpm db:migrate:apply` refuses while a migration lock is held; the Claude hook denies raw `prisma migrate resolve`.
- Enum value removal: the generated sync trigger is now `0_cockpit_context_sync_<hash>`, so it fires before the app's own BEFORE triggers. `pnpm backup:test`, `pnpm db:test-migrations` and `pnpm runtime:test-operations` take `--container-prefix` or `TEST_CONTAINER_PREFIX` for every container, network and throwaway image they create.
- The backups-off notice is printed by the entrypoint's backups check (`pre-migrate.sh --startup-notice`) instead of the server, so a `migrate` job with backups off prints it too.
- `pnpm dokploy:verify` checks the Compose project's single `app` container (`--project <compose project> --url <origin> --commit <sha>`) instead of Swarm services, and passes only when `/ready` reports that commit.
- With `compose.backup.yaml`, the backup scheduler is created after the app, so the two never fill their shared fresh `/backups` volume at once.
- The iOS home-screen icon (Apple touch icon) is the new app tile, flattened onto its own background; the favicon and PWA icons are unchanged.

### Fixed

- A missing file under `/assets/` is a plain uncached 404, not a locale redirect carrying the immutable cache header.
- Admin authority is one function, `checkAdminAuthority`, used by `requireAdmin`, `requireAdminOr404` and the server's admin session gate. It refuses banned users, so every admin gate does (the oRPC admin gates did not check bans before).
- Banned users are refused by every authenticated procedure, not only the admin gates: `requireAuth` (behind `authenticatedProcedure`, `protectedProcedure` and `adminProcedure`) and the 2FA gate apply the shared `checkSessionAccess`, so a session issued before the ban answers UNAUTHORIZED.
- Better-Auth's own routes (`/api/auth/*`, e.g. profile update and MCP OAuth consent/continue) refuse a banned user's surviving session with 401; sign-out still works.
- A ban closes the user's open `conversations.watch` and `conversations.activity` streams with UNAUTHORIZED, and a new stream re-reads the ban from the database when it opens. The 60 s signed cookie cache stays the bound everywhere else.
