# Changelog

All notable changes are documented here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and [Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

### Added

- First release of Cockpit Context.
- Source-grounded dependency investigations over MCP at requested package versions or Git refs.
- Web management of packages, proposals, repository checkouts and live conversations, with steering, stop and follow-ups.
- OAuth and revocable per-user API tokens, private SSH dependencies and one-time-key snapshots.
- Confined search/read and sandboxed TypeScript/JavaScript and Python language-server tools, bounded runs and cache pruning.
- Single-container application with PostgreSQL metadata, in-process jobs, administrator controls, committed schema migrations and database backup/restore tooling. Backups are opt-in (`BACKUP_ENABLED=true`, which then requires a usable destination); `TRUST_PROXY_HOPS` defaults to `0`, so set `1` behind Traefik, Dokploy or Caddy ([docs/deploy.md](./docs/deploy.md), [docs/backup-restore.md](./docs/backup-restore.md)).
- Banned users are refused by every authenticated procedure, MCP credential and Better-Auth route except sign-out, at most 60 s after the ban (the signed session cookie cache); a ban made through the app also closes their open conversation streams and MCP requests and stops their runs. Every admin gate uses the one `checkAdminAuthority` rule ([docs/access-matrix.md](./docs/access-matrix.md)).
- MCP `query_dependency` and `get_query_result` results report the finished query's model spend as `usage` (`cost_usd_micros`, `priced`, input, output and cached input tokens, `model`), summed over the main run and its helper runs. An unpriced model call makes the cost unknown (`priced: false`, `cost_usd_micros: null`), never 0; runs record unpriced calls in `agent_run.unpricedCalls`, and a model call that fails after reporting usage keeps its tokens. The dashboard's conversation header and list rows mark such a cost as a lower bound (`≥ $0.04, some calls unpriced`) or unknown, never as a plain total. A reused result reports zero new spend in `usage` and the shared investigation's spend in `original_usage`; callers count a query's `usage` once per `query_id` ([docs/mcp.md](./docs/mcp.md#query-cost)).
