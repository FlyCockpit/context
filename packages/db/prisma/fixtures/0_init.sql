-- Synthetic 1.0.0 replay data only. No credential here can authenticate or decrypt.
INSERT INTO "user" (id, name, email, role) VALUES
  ('fx_owner', 'Fixture Owner', 'owner@example.invalid', 'user'),
  ('fx_reader', 'Fixture Reader', 'reader@example.invalid', 'user');

INSERT INTO ssh_key (id, "ownerId", name, source, algorithm, "publicKey", fingerprint,
                     "keyVersion", nonce, "authTag", ciphertext) VALUES
  ('fx_key', 'fx_owner', 'Synthetic metadata', 'IMPORTED', 'ssh-ed25519',
   'ssh-ed25519 FIXTURE-NOT-A-KEY', 'SHA256:FIXTURE-NOT-A-FINGERPRINT', 'fixture-only',
   decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), decode('00010203', 'hex'));

INSERT INTO repository (id, "remoteUrl", "remoteKey", visibility, "ownerId", "ownerScope",
                        "isSnapshot", "sshKeyId", status, "defaultBranch", "diskBytes") VALUES
  ('fx_public', 'https://example.invalid/shared.git', 'https://example.invalid/shared',
   'PUBLIC', NULL, '', false, NULL, 'READY', 'main', 1024),
  ('fx_private', 'ssh://git@example.invalid/owned.git', 'ssh://git@example.invalid/owned',
   'PRIVATE', 'fx_owner', 'fx_owner', false, 'fx_key', 'READY', 'main', 2048),
  ('fx_snapshot', 'ssh://git@example.invalid/owned.git', 'ssh://git@example.invalid/owned',
   'PRIVATE', 'fx_owner', 'snapshot-fixture-unique-scope', true, NULL, 'READY', 'main', 4096);

INSERT INTO package (id, "ownerId", identifier, ecosystem, name, "displayName", "gitUrl",
                     "isSnapshot", "sshKeyId", "repositoryId", notes) VALUES
  ('fx_package_public', 'fx_owner', 'npm:fixture-shared', 'NPM', 'fixture-shared', 'Shared fixture',
   'https://example.invalid/shared.git', false, NULL, 'fx_public', 'Owner context'),
  ('fx_package_reader', 'fx_reader', 'npm:fixture-shared', 'NPM', 'fixture-shared', 'Shared fixture',
   'https://example.invalid/shared.git', false, NULL, 'fx_public', 'Reader context'),
  ('fx_package_private', 'fx_owner', 'git:fixture/owned', 'GIT', 'fixture/owned', 'Private fixture',
   'ssh://git@example.invalid/owned.git', false, 'fx_key', 'fx_private', NULL),
  ('fx_package_snapshot', 'fx_owner', 'git:fixture/snapshot', 'GIT', 'fixture/snapshot', 'Snapshot fixture',
   'ssh://git@example.invalid/owned.git', true, NULL, 'fx_snapshot', 'Protected snapshot');

INSERT INTO checkout (id, "repositoryId", sha, status, "resolvedFrom", "diskBytes", summary, "summaryStatus") VALUES
  ('fx_checkout_public', 'fx_public', repeat('a', 40), 'READY', 'tag:v1.0.0', 512, 'Shared overview', 'READY'),
  ('fx_checkout_private', 'fx_private', repeat('b', 40), 'READY', 'branch:main', 1024, NULL, 'NONE'),
  ('fx_checkout_snapshot', 'fx_snapshot', repeat('c', 40), 'READY', 'commit', 2048, NULL, 'PENDING');
INSERT INTO checkout_summary_override (id, "checkoutId", "userId", body) VALUES
  ('fx_override', 'fx_checkout_public', 'fx_reader', 'Private reader override');

INSERT INTO mcp_agent_token (id, "userId", name, "lookupPrefix", "secretDigest", "allowPropose", "autoApprove") VALUES
  ('fx_token', 'fx_owner', 'Fixture agent', 'fixture-only', 'fixture-not-a-real-hmac', true, false);
INSERT INTO mcp_grant (id, "userId", "clientId", "referenceId", "clientName") VALUES
  ('fx_grant', 'fx_reader', 'fixture-client', 'fixture-consent', 'Synthetic OAuth client');
INSERT INTO oauth_client (id, "clientId", name, scopes, contacts, "redirectUris", "postLogoutRedirectUris", "grantTypes", "responseTypes") VALUES
  ('fx_oauth_client', 'fixture-client', 'Synthetic OAuth client', ARRAY['mcp'], ARRAY['oauth@example.invalid'],
   ARRAY['https://example.invalid/callback'], ARRAY[]::text[], ARRAY['authorization_code'], ARRAY['code']);
INSERT INTO oauth_refresh_token (id, token, "clientId", "userId", resources, "requestedUserInfoClaims", "expiresAt", scopes) VALUES
  ('fx_refresh', 'fixture-not-a-real-refresh-token', 'fixture-client', 'fx_reader', ARRAY['https://example.invalid/mcp'],
   ARRAY[]::text[], '2099-01-01', ARRAY['mcp']);
INSERT INTO oauth_access_token (id, token, "clientId", "userId", "refreshId", resources, "requestedUserInfoClaims", "expiresAt", scopes) VALUES
  ('fx_access', 'fixture-not-a-real-access-token', 'fixture-client', 'fx_reader', 'fx_refresh', ARRAY['https://example.invalid/mcp'],
   ARRAY[]::text[], '2099-01-01', ARRAY['mcp']);
INSERT INTO oauth_consent (id, "clientId", "userId", "referenceId", resources, "requestedUserInfoClaims", scopes) VALUES
  ('fx_consent', 'fixture-client', 'fx_reader', 'fixture-consent', ARRAY['https://example.invalid/mcp'], ARRAY[]::text[], ARRAY['mcp']);
INSERT INTO oauth_client_assertion (id, "expiresAt") VALUES ('fx_assertion', '2000-01-01');

INSERT INTO conversation (id, "ownerId", "packageId", "packageIdentifier", "requestedVersion", "checkoutId", "commitSha", origin,
                          "mcpAgentTokenId", "mcpGrantId", "mcpConnectionLabel", title) VALUES
  ('fx_conversation_owner', 'fx_owner', 'fx_package_public', 'npm:fixture-shared', '1.0.0',
   'fx_checkout_public', repeat('a', 40), 'MCP', 'fx_token', NULL, 'Fixture agent', 'Fixture question'),
  ('fx_conversation_reader', 'fx_reader', 'fx_package_reader', 'npm:fixture-shared', '1.0.0',
   'fx_checkout_public', repeat('a', 40), 'MCP', NULL, 'fx_grant', 'Synthetic OAuth client', 'Reader question');
INSERT INTO agent_run (id, "ownerId", "conversationId", "checkoutId", kind, status, trigger, answer, "finishedAt") VALUES
  ('fx_run_done', 'fx_owner', 'fx_conversation_owner', 'fx_checkout_public', 'MAIN', 'COMPLETED', 'MCP_QUERY',
   'Synthetic answer from the fixture checkout.', '2026-01-01'),
  ('fx_run_live', 'fx_reader', 'fx_conversation_reader', 'fx_checkout_public', 'MAIN', 'RUNNING', 'MCP_QUERY', NULL, NULL);
INSERT INTO run_turn (id, "runId", seq, role, parts) VALUES
  ('fx_turn_user', 'fx_run_done', 0, 'USER', '[{"type":"text","text":"Explain the fixture export."}]'),
  ('fx_turn_answer', 'fx_run_done', 1, 'ASSISTANT', '[{"type":"text","text":"Synthetic answer from the fixture checkout."}]');
INSERT INTO checkout_lease (id, "checkoutId", "runId", "expiresAt") VALUES
  ('fx_lease', 'fx_checkout_public', 'fx_run_live', '2099-01-01');
INSERT INTO background_job (id, type, payload, status, "dedupeKey") VALUES
  ('fx_job_queued', 'oauth.cleanup', '{}', 'queued', 'fixture-oauth-cleanup'),
  ('fx_job_done', 'auth.reap-expired-tokens', '{}', 'succeeded', 'fixture-auth-cleanup');
