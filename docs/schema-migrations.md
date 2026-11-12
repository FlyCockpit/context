# Schema migrations

Cockpit Context uses Prisma Migrate with reviewed, committed SQL. `packages/db/prisma/schema/` describes the desired schema; `packages/db/prisma/migrations/0_init/migration.sql` is the fresh-install baseline. Subsequent timestamped folders hold `migration.sql` and, for scheduled deletion, `contract.sql`. Schema and SQL ship together. A folder merged into main is immutable.

## Local commands

| Command | Purpose |
|---|---|
| `pnpm db:worktree` | Create this checkout's local and shadow databases and configure its database URL. |
| `pnpm db:migrate <name>` | Generate expand SQL and optional delayed contract; applies nothing. |
| `pnpm db:migrate:apply` | Apply local migrations and regenerate the client; skips contracts. |
| `pnpm db:migrate:rebase` | Reorder unmerged folders after rebasing and recheck consistency. |
| `pnpm db:reset:local` | Explicitly rebuild only this checkout's disposable local DB, including contracts and seed. |
| `pnpm db:check-migrations --base <ref>` | Check migrations on a disposable CHECK_DATABASE_URL. |
| `pnpm db:test-unit` / `pnpm db:test-migrations` | Database-free runner tests / isolated real-Postgres migration checks. |

Wrappers require this checkout's exact local database/shadow names on localhost, 127.0.0.1 or ::1 and reject connection-redirect URL parameters. Never point generation, reset or checks at shared databases. The root checkout uses `cockpit_context` after setup; worktrees get a deterministic suffix. Do not bypass a missing native child guard.

Edit schema, generate, inspect SQL, add backfills/fixtures, apply locally, and submit schema plus migration together. Use mapped database names for renames and the [change recipe](./schema-changes-recipe.md) for type changes.

## Migration markers and checks

Keep generated transactional, history-capture and commit-marker blocks byte-identical. Put hand-written SQL between them. Recovery uses these markers to distinguish committed work from rolled-back attempts. A reviewed annotation attests compatibility of otherwise opaque SQL; it cannot excuse a breaking change. Never hand-write a contract or generated relax/enum-removal/recovery block. Use `--empty` for a backfill and a separately reviewed `--empty --no-transaction` migration where a transaction is impossible.

Five checks block inconsistent replay/catalog state, out-of-order new folders, changes to merged files, data-fixture failures, and unsafe SQL/accidental renames/retired-name reuse. Fixtures live in `packages/db/prisma/fixtures/<folder>.sql` and `<folder>.check.sql`; checks return zero wrong rows. Include edge cases and custom constraints/indexes that Prisma cannot express.

## Startup and image commands

`MIGRATE_ON_START=true` is the default server behavior: the image runner serializes classification, optional pre-migration backup, deploy and due contracts under database advisory locks before starting the app. There is one app container, no worker. For an explicit one-shot `migrate` job, run it before app start and set `MIGRATE_ON_START=false` on the app. False performs a bounded 300-second wait/admission and never runs contracts. One-shot commands do not register runtime instances.

```sh
docker compose -p cockpit-context run --rm --no-deps app migrate
```

| Database state | Result |
|---|---|
| up-to-date | Register and start; the leader may run due safe contracts. |
| pending | Validate, run backup hook, deploy pending SQL, then admit. |
| db-ahead | Admit only if newer migrations remain rollback-safe and no corresponding contract ran. |
| failed | Wait for an active runner or recover an intact transactional attempt once; otherwise refuse. |
| no-history-nonempty | Refuse; never automatically adopt an existing database. |
| unreachable | Refuse or wait until timeout, depending on mode. |

The pre-migration hook uses database-only pg_dump archives. No configured destination means a warning and no dump; a configured backup failure blocks mutation. This is not a full-volume or encrypted-bundle requirement. Configure durable backups before production schema changes. See [backup/restore](./backup-restore.md).

## Expand and contract

The generator preserves running-release compatibility in `migration.sql` and moves removals into `contract.sql`. Contracts wait at least seven days after the new release is ready, with no live older registration and no active hold. The runner checks checksums, templates, retired names and catalog state and calls the pre-drop backup hook. Main-run jobs and heartbeat stay in the single app process; no separate worker is introduced.

In-place breaking drops, renames and type changes on initialized databases are refused. There is no maintenance override. Use `@map`/`@@map`, generated contracts and the two-PR type-change recipe. Never reuse a retired database name.

```sh
docker compose -p cockpit-context run --rm --no-deps app hold-deletions 7
```

The owner hold accepts 1–90 days or `--clear`. Restore creates a seven-day hold without shortening an existing longer hold. Clearing a hold does not reverse a deletion.

## Recovery

An intact transactional migration with its commit marker is resolved applied without replay. Without the marker it is resolved rolled back before backup/retry. Broken wrappers, checksum changes or repeat failures refuse deployment. Inspect history read-only and fix forward with a new migration; never edit merged SQL or clear history to force admission. Prisma deploy/diff/resolve are runner-wrapper operations, not operator shortcuts.

A database with tables but no history is refused. Use a fresh empty destination or separately reviewed maintainer recovery; there is no legacy adoption path. An old image may be rejected after a contract, so prefer a correction built against the current schema. Restore is offline and explicit: see [backup/restore](./backup-restore.md). These documents describe tooling behavior, not evidence of a completed production restore drill.
