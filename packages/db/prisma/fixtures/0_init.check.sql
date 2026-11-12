-- Every SELECT returns zero violating rows; behavioral probes always roll back.
SELECT 'users' AS violation WHERE (SELECT count(*) FROM "user" WHERE id IN ('fx_owner', 'fx_reader')) <> 2;
SELECT p.id FROM package p JOIN repository r ON r.id = p."repositoryId"
 WHERE p.id LIKE 'fx_%' AND r.visibility = 'PRIVATE' AND p."ownerId" IS DISTINCT FROM r."ownerId";
SELECT id FROM repository WHERE id LIKE 'fx_%' AND
 ((visibility = 'PUBLIC' AND ("ownerId" IS NOT NULL OR "ownerScope" <> '')) OR
  (visibility = 'PRIVATE' AND "ownerId" IS NULL));
SELECT 'shared ownership' AS violation WHERE
 (SELECT count(DISTINCT "ownerId") FROM package WHERE "repositoryId" = 'fx_public') <> 2;
SELECT 'snapshot' AS violation WHERE NOT EXISTS
 (SELECT FROM repository WHERE id = 'fx_snapshot' AND "isSnapshot" AND "ownerScope" <> 'fx_owner');
SELECT 'lease' AS violation WHERE NOT EXISTS
 (SELECT FROM checkout_lease l JOIN agent_run r ON r.id = l."runId"
  WHERE l.id = 'fx_lease' AND r.status = 'RUNNING' AND l."checkoutId" = r."checkoutId");
SELECT 'turn order' AS violation WHERE
 (SELECT array_agg(seq ORDER BY seq) FROM run_turn WHERE "runId" = 'fx_run_done') IS DISTINCT FROM ARRAY[0, 1];
SELECT 'oauth relation' AS violation WHERE NOT EXISTS
 (SELECT FROM oauth_access_token a JOIN oauth_refresh_token r ON r.id = a."refreshId"
  JOIN oauth_consent c ON c."clientId" = a."clientId" AND c."userId" = a."userId"
  WHERE a.id = 'fx_access' AND r."userId" = a."userId");
SELECT 'pg_trgm' AS violation WHERE NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_trgm');
SELECT expected.name AS missing_index FROM (VALUES
 ('user_email_idx'), ('user_name_idx'), ('oauth_access_token_expiresAt_idx'),
 ('oauth_refresh_token_expiresAt_idx'), ('oauth_client_assertion_expiresAt_idx'), ('oauth_client_createdAt_idx')
) AS expected(name) WHERE NOT EXISTS
 (SELECT FROM pg_indexes i WHERE i.schemaname = current_schema() AND i.indexname = expected.name);
SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
 AND indexname IN ('user_email_idx', 'user_name_idx') AND indexdef NOT LIKE '%USING gin%gin_trgm_ops%';

-- FK/unique failures are caught in subtransactions; successful destructive probes
-- raise a private rollback sentinel after their assertions, leaving fixtures intact.
DO $cockpit_context_fixture$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    DELETE FROM ssh_key WHERE id = 'fx_key';
  EXCEPTION WHEN foreign_key_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Package SSH key NO ACTION was lost'; END IF;
END $cockpit_context_fixture$;

DO $cockpit_context_fixture$
BEGIN
  BEGIN
    DELETE FROM checkout WHERE id = 'fx_checkout_public';
    IF EXISTS (SELECT FROM conversation WHERE id LIKE 'fx_conversation_%' AND "checkoutId" IS NOT NULL)
       OR EXISTS (SELECT FROM agent_run WHERE id LIKE 'fx_run_%' AND "checkoutId" IS NOT NULL)
       OR EXISTS (SELECT FROM checkout_lease WHERE id = 'fx_lease')
       OR EXISTS (SELECT FROM checkout_summary_override WHERE id = 'fx_override') THEN
      RAISE EXCEPTION 'Checkout SetNull/Cascade was lost';
    END IF;
    RAISE SQLSTATE 'ZX001' USING MESSAGE = 'rollback successful fixture probe';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  BEGIN
    DELETE FROM repository WHERE id = 'fx_private';
    IF EXISTS (SELECT FROM checkout WHERE id = 'fx_checkout_private') OR
       EXISTS (SELECT FROM package WHERE id = 'fx_package_private' AND "repositoryId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Repository SetNull/Cascade was lost';
    END IF;
    RAISE SQLSTATE 'ZX001' USING MESSAGE = 'rollback successful fixture probe';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  BEGIN
    DELETE FROM "user" WHERE id = 'fx_owner';
    IF EXISTS (SELECT FROM package WHERE "ownerId" = 'fx_owner') OR
       EXISTS (SELECT FROM repository WHERE "ownerId" = 'fx_owner') OR
       EXISTS (SELECT FROM ssh_key WHERE "ownerId" = 'fx_owner') OR
       EXISTS (SELECT FROM conversation WHERE "ownerId" = 'fx_owner') OR
       EXISTS (SELECT FROM run_turn WHERE "runId" = 'fx_run_done') OR
       NOT EXISTS (SELECT FROM package WHERE id = 'fx_package_reader') OR
       NOT EXISTS (SELECT FROM repository WHERE id = 'fx_public') THEN
      RAISE EXCEPTION 'Owner cascade or public sharing was lost';
    END IF;
    RAISE SQLSTATE 'ZX001' USING MESSAGE = 'rollback successful fixture probe';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
END $cockpit_context_fixture$;

DO $cockpit_context_fixture$
DECLARE refused boolean;
BEGIN
  refused := false;
  BEGIN
    UPDATE package SET identifier = 'npm:fixture-shared' WHERE id = 'fx_package_private';
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Owner/identifier unique constraint was lost'; END IF;
  refused := false;
  BEGIN
    UPDATE repository SET "ownerScope" = 'fx_owner' WHERE id = 'fx_snapshot';
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Remote/scope unique constraint was lost'; END IF;
  refused := false;
  BEGIN
    INSERT INTO checkout (id, "repositoryId", sha) VALUES ('fx_duplicate', 'fx_public', repeat('a', 40));
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Repository/SHA unique constraint was lost'; END IF;
END $cockpit_context_fixture$;
