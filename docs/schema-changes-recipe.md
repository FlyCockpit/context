# Schema changes recipe

Read [migration mechanics](./schema-migrations.md) and the [access matrix](./access-matrix.md) before changing a model. This app runs one container; stop-first deployment does not waive compatibility rules or permit a second replica.

## Add a field or model

1. Edit `packages/db/prisma/schema/`. Make a new field nullable or supply a valid default/backfill for existing rows. Models need IDs and timestamps; ownership relations need indexes and explicit relations. Money uses integer minor units, never Float.
2. Run `pnpm db:migrate add_descriptive_name`; it generates SQL only.
3. Read `migration.sql` and any `contract.sql`. Preserve the generated wrapper and marker blocks. Add backfills between generated blocks when necessary.
4. Add representative data fixtures and zero-row invariant checks in `packages/db/prisma/fixtures/` when stored data or constraints change.
5. Run `pnpm db:migrate:apply`, relevant tests and migration checks. Submit schema, migration and fixtures together. Show reviewers the destructive-SQL summary.

Use `pnpm db:migrate backfill_name --empty` for a data-only change. Nontransactional statements belong in a separate reviewed `--empty --no-transaction` migration, with their recovery implications documented.

## Rename

Use Prisma `@map("existing_column")` or `@@map("existing_table")` to change code names while preserving database names and data. Do not replace a rename with drop-and-add. A real physical rename needs an explicitly reviewed compatible multi-release plan.

## Type changes: two PRs

First add a new column with the desired type, backfill/cast safely, and introduce compatible reads/writes while keeping the original field. Test old and new data, including nulls and conversion failures. Deploy and verify the transition.

In a later PR switch entirely to the new column and remove the old field from the schema. Generate the migration; the old column remains until its generated contract is eligible after at least seven days and no older release remains. Never reuse the retired database name. Primary-key changes use a new-table/copy/switch plan rather than in-place mutation.

## Remove or recover a field

Remove the field from application reads/writes and schema, then generate. The generator relaxes old-write requirements during expansion and schedules deletion in `contract.sql`. Review both. Contracts are generated, never hand-written.

For enum removal use `--remap 'Enum.OLD=NEW'` and inspect the generated remap/sync behavior. Before a retired field is deleted, use `--recover 'table.old=new'` to generate recovery into a new field. After deletion, recover from an isolated restore of a pre-drop backup; a production restore rolls back other data too and requires a recovery decision.

## What CI checks

Migration replay must match the Prisma schema and application catalog; new folders sort after the base branch; merged files remain byte-identical; realistic fixtures retain their invariants; and safety analysis rejects breaking SQL, invalid generated blocks, accidental renames and retired-name reuse. Rebase unmerged folders with `pnpm db:migrate:rebase`, never retimestamp a merged folder.

For full commands, deployment admission and failed-transaction recovery see [schema migrations](./schema-migrations.md). For backup scope and confirmation see [backup/restore](./backup-restore.md).
