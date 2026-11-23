# Schema migrations

Cockpit Context uses Prisma Migrate with reviewed, committed SQL. `packages/db/prisma/schema/` describes the desired schema; `packages/db/prisma/migrations/0_init/migration.sql` is the fresh-install baseline. Subsequent timestamped folders hold `migration.sql` and, for scheduled deletion, `contract.sql`, one per PR; at each release the folders added since the last release tag are squashed into one release migration ([§ Releases](#releases)), so an upgrade from one release to the next runs exactly one migration. Schema and SQL ship together. A folder merged into main is immutable; the one exception is the release squash, which moves folders added since the last release into the release folder byte for byte. A folder in a release tag never changes.

## Local commands

| Command | Purpose |
|---|---|
| `pnpm db:worktree` | Create this checkout's local and shadow databases, mark each one it creates as disposable, and configure its database URL. `--adopt` (a person at a terminal) marks an older one. |
| `pnpm db:migrate <name>` | Generate expand SQL and optional delayed contract; applies nothing. |
| `pnpm db:migrate:apply` | Apply local migrations and regenerate the client; skips contracts. Takes the migration runner lock and refuses, changing nothing, while another session holds it or Prisma's lock. |
| `pnpm db:migrate:rebase` | Reorder unmerged folders after rebasing and recheck consistency. |
| `pnpm db:reset:local` | Explicitly rebuild only this checkout's disposable local DB, including contracts and seed; refuses a database without the disposable-local mark, and `EXPECTED_DB`. |
| `pnpm db:check-migrations --base <ref>` | Check migrations on a disposable CHECK_DATABASE_URL. |
| `pnpm db:release-squash <last-tag> <release-name>` | In the version-bump PR: squash every migration added since `<last-tag>` into one release folder. Writes files only. |
| `pnpm db:check-release <last-tag>` | The release PR's checks (Guards A and B) against `<last-tag>` on a disposable CHECK_DATABASE_URL. |
| `pnpm db:baseline` | Template tooling for a new app's first history; inert here (it refuses without the template's `template-history.json` marker). |
| `pnpm db:test-unit` / `pnpm db:test-migrations` | Database-free runner tests / isolated real-Postgres migration checks. `db:test-migrations` starts a throwaway `postgres:18` container named `<prefix>-<hex>` (`--container-prefix <prefix>`, else `TEST_CONTAINER_PREFIX`; default `cockpit-context-test-migrations`) and removes it at the end, also on Ctrl-C; `--server-url <superuser url>` uses a disposable server you already run. Every database and role it creates has a per-run random name, so it never touches `cockpit_context` or a checkout's database. |

Wrappers require this checkout's exact local database/shadow names on localhost, 127.0.0.1 or ::1 and reject connection-redirect URL parameters. Never point generation, reset or checks at shared databases. The root checkout uses `cockpit_context` after setup; worktrees get a deterministic suffix. Do not bypass a missing native child guard.

Edit schema, generate, inspect SQL, add backfills/fixtures, apply locally, and submit schema plus migration together. Use mapped database names for renames and the [change recipe](./schema-changes-recipe.md) for type changes.

## Migration markers and checks

Keep generated transactional, history-capture and commit-marker blocks byte-identical. Put hand-written SQL between them. Recovery uses these markers to distinguish committed work from rolled-back attempts. A reviewed annotation attests compatibility of otherwise opaque SQL; it cannot excuse a breaking change. Never hand-write a contract or generated relax/enum-removal/recovery block. Use `--empty` for a backfill and a separately reviewed `--empty --no-transaction` migration where a transaction is impossible.

Five checks block inconsistent replay/catalog state, out-of-order new folders, changes to merged files, data-fixture failures, and unsafe SQL/accidental renames/retired-name reuse; a sixth checks a release squash. Fixtures live in `packages/db/prisma/fixtures/<folder>.sql` and `<folder>.check.sql`; checks return zero wrong rows. Never assert that a fixture row exists: CI also runs every check on databases that never had your rows (a release applied to the last release's data, [§ Releases](#releases) Guard B). A release moves each squashed folder's data fixture to `fixtures/<release>/<folder>.sql`, which CI loads right after that folder's section of the release. Include edge cases and custom constraints/indexes that Prisma cannot express.

## Startup and image commands

`MIGRATE_ON_START=true` is the default server behavior: the image runner serializes classification, optional pre-migration backup, deploy and due contracts under database advisory locks before starting the app. There is one app container, no worker. For an explicit one-shot `migrate` job, run it before app start and set `MIGRATE_ON_START=false` on the app. False performs a bounded 300-second wait/admission and never runs contracts. One-shot commands do not register runtime instances.

```sh
docker compose -p cockpit-context run --rm --no-deps app migrate
```

| Database state | Result |
|---|---|
| up-to-date | Register and start; the leader may run due safe contracts. |
| pending | Validate, run the backup hook only when opted in, deploy pending SQL, then admit. |
| db-ahead | Admit only if newer migrations remain rollback-safe and no corresponding contract ran. |
| failed | Wait for an active runner or recover an intact transactional attempt once; otherwise refuse. |
| no-history-nonempty | Refuse; never automatically adopt an existing database. |
| unreachable | Refuse or wait until timeout, depending on mode. |

**Release migrations.** Before it classifies the database, the leader reconciles migrations that a release folder replaced ([§ Releases](#releases)): a database that applied some or all of them one by one is moved onto the release in one transaction, instead of being treated as db-ahead.

Backups default off (`BACKUP_ENABLED=false`): migrations and scheduled deletions never call the backup hook, even if storage is present. With `BACKUP_ENABLED=true` the runner calls `scripts/backup/pre-migrate.sh --required` (a database-only pg_dump archive) before every pending deploy, a fresh database included: there is no fresh-install exemption. No usable destination, a failed dump, or no hook in the image stops the migration before anything is applied. Before the first due scheduled deletion it calls `pre-migrate.sh --label pre-drop --keep 5 --required` unless this run already took the pre-migration backup; a failure, a missing destination or a missing hook skips every deletion this run (the app still starts). Durable backups are recommended but opt-in. See [backup/restore](./backup-restore.md).

## Expand and contract

The generator preserves running-release compatibility in `migration.sql` and moves removals into `contract.sql`. An enum value removal (`--remap 'E.OLD=NEW'`) adds a `BEFORE INSERT OR UPDATE` trigger per affected table that rewrites `OLD` to `NEW` during the overlap. It is named `0_cockpit_context_sync_<hash>`: BEFORE triggers on a table fire in name order (byte order), so it runs before every trigger with an unquoted name and every quoted one starting with a letter, and they see `NEW`, never `OLD`; only a quoted name starting with a space, punctuation or `0` could sort earlier. The contract drops it. Contracts wait at least seven days after the new release is ready, with no live older registration and no active hold. The runner checks checksums, templates, retired names and catalog state and calls the pre-drop backup hook only with `BACKUP_ENABLED=true`. Main-run jobs and heartbeat stay in the single app process; no separate worker is introduced.

In-place breaking drops, renames and type changes on initialized databases are refused. There is no maintenance override. Use `@map`/`@@map`, generated contracts and the two-PR type-change recipe. Never reuse a retired database name.

```sh
docker compose -p cockpit-context run --rm --no-deps app hold-deletions 7
```

The owner hold accepts 1–90 days or `--clear`. Restore creates a seven-day hold without shortening an existing longer hold. Clearing a hold does not reverse a deletion.

## Releases

One migration per release. Every PR that changes the schema ships its own migration; the version-bump PR squashes every migration added since the last release tag into one release migration. The squash **concatenates** the reviewed SQL instead of regenerating it from a schema diff (which would turn a rename into drop + add and lose backfills). Release tags are `v*` (`RELEASE_TAG_PATTERN` overrides that for the tooling).

In every PR: renames are never drop + add (keep the name with `@map`/`@@map`, or add the new column, copy the data in the same migration and let `contract.sql` delete the old one); backfills live in the migration; every data change gets fixtures and a `.check.sql`; dev and test databases always run real migrations. A non-transactional migration or an enum-value removal cannot be squashed: keep migrations transactional, and avoid removing an enum value late in a release cycle.

In the version-bump PR, on a clean tree:

```bash
pnpm db:release-squash v1.1.0 1.2.0   # last release tag, new release name
git diff                               # review: one release folder, the per-PR folders gone
CHECK_DATABASE_URL=<disposable superuser URL> pnpm db:check-release v1.1.0
pnpm db:migrate:apply                  # your local database is reconciled onto the release
```

It refuses unless the tag's migrations are untouched, and writes `<timestamp>_release_1_2_0/`: `migration.sql` (the replaced bodies in folder order inside one generated transactional wrapper, each section headed `-- cockpit_context:from <folder>`), `contract.sql` (the replaced contracts, same headers, only when one had a contract), `replaces.json` (replaced folder names and file sha256s) and `replaced/<folder>/` (byte-exact copies). It deletes the per-PR folders and removes the previous release's `replaced/` and `replaces.json`. Data fixtures move to `fixtures/<release>/<folder>.sql`; checks are concatenated into `fixtures/<release>.check.sql`. Never edit a release folder by hand; CI regenerates it from `replaced/` and requires an exact match. If another migration merges first and sorts after the release folder, redo the squash on the rebased branch; `pnpm db:migrate:rebase` refuses to re-timestamp a release folder. A migration without the transactional wrapper or with an enum-remove block makes the squash refuse, writing nothing: release without a squash that time.

`pnpm db:check-release <last-tag>` (CI runs it on every PR that adds a release folder): **Guard A, equivalence** — the head reproduces the Prisma schema from empty and from the tag, the release is exactly the replaced SQL in `replaces.json` order, and a database built from every prefix of the replaced chain (with and without its scheduled deletions), reconciled by the runner's own code, ends with the fresh database's schema and passes every fixture check. **Guard B, upgrade** — a database at the tag with its fixture data, then the release: every row survives and every `.check.sql` returns no rows. Plus immutability against the tag.

Deploying from releases or from the default branch both work. The runner (and `pnpm db:migrate:apply`) reads each release folder's `replaces.json` before deploying:

| The database applied … | What happens |
|---|---|
| none of the replaced migrations | The release migration applies normally. |
| all of them (a test deployment tracking main) | One transaction: the release is recorded as applied and the replaced rows are removed. No schema SQL runs. |
| some of them | One transaction: the missing ones run from `replaced/` in order, then as above. The pre-migration backup runs first when backups are on. |

Scheduled deletions follow: if every replaced `contract.sql` already ran, the release's contract is recorded as applied; if some did, only the remaining sections run after the usual soak. Either way the release is then not rollback-safe. The runner refuses to start, changing nothing, when a `replaced/` copy does not match `replaces.json`, when an applied replaced migration differs from what `replaces.json` records or is recorded as failed, or when the database has an applied migration that is neither in the image nor replaced (another branch's database). A database that skipped a whole release with only some replaced migrations applied, after `replaced/` was removed, is refused as db-ahead: deploy that release's image first.

## Recovery

An intact transactional migration with its commit marker is resolved applied without replay. Without the marker it is resolved rolled back before backup/retry. Broken wrappers, checksum changes or repeat failures refuse deployment. Inspect history read-only and fix forward with a new migration; never edit merged SQL or clear history to force admission. Prisma deploy/diff/resolve are runner-wrapper operations, not operator shortcuts.

A database with tables but no history is refused. Use a fresh empty destination or separately reviewed maintainer recovery; there is no legacy adoption path. An old image may be rejected after a contract, so prefer a correction built against the current schema. Restore is offline and explicit: see [backup/restore](./backup-restore.md). These documents describe tooling behavior, not evidence of a completed production restore drill.
