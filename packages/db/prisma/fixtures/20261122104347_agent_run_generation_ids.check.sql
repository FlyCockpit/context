-- Runs that existed before the column read as "no generation ids", never NULL.
SELECT id FROM agent_run WHERE id LIKE 'fx_%' AND "generationIds" IS DISTINCT FROM ARRAY[]::TEXT[];
