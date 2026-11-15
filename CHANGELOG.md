# Changelog

All notable changes are documented here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Backups are now opt-in with `BACKUP_ENABLED=true`. `TRUST_PROXY_HOPS` now defaults to `0`; set `1` behind Traefik, Dokploy or Caddy.
- `BACKUP_ENABLED=true` now needs a usable destination: a migrating start fails without one, a brand-new database too. The runner takes the pre-migration and pre-drop dumps in required mode.
- The image entrypoint is PID 1 while it migrates, forwards stop signals to the startup check and the migration runner (exit 143/130/129), then drops the backup writer keys and execs `tini` with the server.
- Restore: every refusal, usage error, cancel or signal before the restore transaction exits 3 (`REFUSED:`); a restore counts as complete only when its COMMIT is confirmed; archives with large objects are refused. `host.sh` restarts the app only after exit 3 (nothing changed); after a completed restore (0) it leaves it stopped and prints the next steps (`/data` snapshot clones, keyring check, then the start command), and after any other status it leaves it stopped and prints the start command; declining or interrupting its stop prompt exits 3; `restore | tee` works and keeps the exit status.
- Local dev: `pnpm db:reset:local` refuses databases without the disposable-local mark (adopt an existing dev database once with `pnpm db:worktree --adopt`); `pnpm db:migrate:apply` refuses while a migration lock is held; the Claude hook denies raw `prisma migrate resolve`.
- Enum value removal: the generated sync trigger is now `0_cockpit_context_sync_<hash>`, so it fires before the app's own BEFORE triggers. `pnpm db:test-migrations` takes `--container-prefix`.
- The backups-off notice is printed by the entrypoint's backups check (`pre-migrate.sh --startup-notice`) instead of the server, so a `migrate` job with backups off prints it too.

### Fixed

- A missing file under `/assets/` is a plain uncached 404, not a locale redirect carrying the immutable cache header.
- Admin authority is one function, `checkAdminAuthority`, used by `requireAdmin`, `requireAdminOr404` and the server's admin session gate. It refuses banned users, so every admin gate does (the oRPC admin gates did not check bans before).
- Banned users are refused by every authenticated procedure, not only the admin gates: `requireAuth` (behind `authenticatedProcedure`, `protectedProcedure` and `adminProcedure`) and the 2FA gate apply the shared `checkSessionAccess`, so a session issued before the ban answers UNAUTHORIZED.
- Better-Auth's own routes (`/api/auth/*`, e.g. profile update and MCP OAuth consent/continue) refuse a banned user's surviving session with 401; sign-out still works.
- A ban closes the user's open `conversations.watch` and `conversations.activity` streams with UNAUTHORIZED, and a new stream re-reads the ban from the database when it opens. The 60 s signed cookie cache stays the bound everywhere else.

## [1.0.0] - 2026-11-11

### Added

- Source-grounded dependency investigations over MCP at requested package versions or Git refs.
- Web management of packages, proposals, repository checkouts and live conversations, with steering, stop and follow-ups.
- OAuth and revocable per-user API tokens, private SSH dependencies and one-time-key snapshots.
- Confined search/read and sandboxed TypeScript/JavaScript and Python language-server tools, bounded runs and cache pruning.
- Single-container application with PostgreSQL metadata, in-process jobs, administrator controls, committed schema migrations and database backup/restore tooling.
