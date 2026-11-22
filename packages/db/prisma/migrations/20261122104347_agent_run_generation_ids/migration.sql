-- cockpit_context:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit_context:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_context$ BEGIN PERFORM set_config('cockpit_context.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_context$;

-- AlterTable
ALTER TABLE "agent_run" ADD COLUMN     "generationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- cockpit_context:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_context$ DECLARE history text := current_setting('cockpit_context.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit_context:committed', history::oid::regclass); END IF; END $cockpit_context$;
COMMIT;
