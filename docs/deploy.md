# Deploy Cockpit Context

## Topology and prerequisites

Use Docker Compose on a Linux host: one Node.js 26.13.1 app container and PostgreSQL 18 (the pinned image is 18.6). There is no Redis or standalone job worker. Run exactly one app replica and use stop-first replacement; in-process event delivery, rate limiters and concurrency are not distributed. See [hosting](./hosting.md).

`compose.yaml` publishes no ports. PostgreSQL lives only on the project-private internal network with alias `cockpit-context-postgres`. App port 3000 is for the reverse proxy. PostgreSQL 18 mounts its parent `/var/lib/postgresql`, with PGDATA `/var/lib/postgresql/18/docker`. `/data` and `/backups` have their own persistent volumes.

Clone the public repository and use a unique project name such as `cockpit-context` on a server also running other services. Do not add `container_name` or global volume/network names. This keeps it separate from WS Sandbox Proxy and Knowledge Base, including their databases.

```sh
git clone https://github.com/FlyCockpit/context.git
cd cockpit-context
cp .env.example .env
```

Edit `.env` privately. Generated examples contain placeholders, not deployment credentials. Do not use `.env.docker.defaults` for production. The supplied Compose file builds `Dockerfile` locally; a published release image is `ghcr.io/flycockpit/context:1.0.0`. To use a published image, override the app and optional backup image consistently and pull the selected release; prefer a digest for immutable deployments.

## Configuration

**Set `ADMIN_EMAILS` before first boot.** Without it nobody can create the administrator; `/login` and `/signup` then say to set it and restart. Do not clear it as a routine post-setup step. Keep `SIGNUP_ENABLED=false` and invite developers after setup.

| Setting | Guidance |
|---|---|
| `POSTGRES_PASSWORD` | Strong unique hex password; Compose interpolates it into DATABASE_URL without URL escaping. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_SECRET` | At least 32 random characters; generate independently per environment and retain securely. |
| `BETTER_AUTH_URL` | Exact HTTPS origin, with no path/query/fragment; browser, OAuth issuer and resource must agree. |
| `ADMIN_EMAILS` | Required initial administrator email allowlist. Use your real controlled address. The first-admin signup also needs the one-time token from the boot log ([First administrator](#first-administrator-private-access-before-public-exposure)). |
| `COCKPIT_CONTEXT_ENCRYPTION_KEYS` | Production keyring, e.g. `v1:<base64 of 32 random bytes>`; generate with `openssl rand -base64 32`. Keep separately for recovery. |
| `OPENROUTER_API_KEY` / `COCKPIT_CONTEXT_MODEL` | Required for real answers; choose an available model ID and provider spend limit. Booting the UI alone does not prove investigations work. |
| `COCKPIT_CONTEXT_DATA_DIR` | `/data` in the image; persistent storage is required. |
| `MIGRATE_ON_START` | True for normal startup; false only with an explicit prior migrate job. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, provider credentials | Optional production SMTP; enables email verification, resets and emailed invitations. Never use development Mailpit as a public relay. |
| `SIGNUP_ENABLED` | Defaults false. True permits the runtime signup toggle; without SMTP it allows unverified addresses and logs a warning. |
| `TRUST_PROXY_HOPS` | Match the actual trusted proxy chain; restrict direct origin access. |
| `CORS_ORIGIN` | Leave unset for same-origin use; no wildcard. |
| `SSO_ENABLED`, OIDC client/secret/issuer/provider settings | Optional configured OIDC sign-in. Review `FORCE_SSO` before enabling; it changes available sign-in methods. |
| `COCKPIT_CONTEXT_OPERATOR_NAME`, `COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL` | Public operator identity for the privacy notice. |
| `COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS` | Defaults 90; 0 disables automatic conversation deletion. Backup retention is separate. |
| `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST` | Optional. Exact host names of internal git servers that may resolve to private addresses; see [Internal git hosts](#internal-git-hosts). |

All accepted names/defaults are in `packages/env/src/vars/` and generated `.env.example`; Admin → Settings shows effective configuration while hiding secret values. An external PostgreSQL deployment needs an explicit DATABASE_URL override rather than the Compose-generated URL. Preserve private networking and URL-encode non-hex credentials.

Questions and dependency source can leave the instance for OpenRouter/model inference. Set provider policy appropriate for your repositories. Saved SSH keys need the keyring; a database backup alone is not full recovery.

### Internal git hosts

By default every git remote (HTTPS and SSH, including host-key scans) must resolve only to public addresses: loopback, RFC 1918, CGNAT, IPv6 unique-local, link-local and cloud-metadata answers are refused, so a user-supplied URL cannot make the server reach your internal network (SSRF). To use an internal GitLab or Gitea, list its exact host names in `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST`, comma-separated, for example `gitlab.corp.example,gitea.corp.example`.

- Only exact, fully qualified names match. Wildcards, ports, IP literals, URLs and `localhost` are rejected at startup; a subdomain of a listed name is not listed.
- A listed name may resolve to RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT 100.64.0.0/10 or IPv6 unique-local fc00::/7 addresses. Loopback, link-local (including 169.254.169.254), the in-range metadata endpoints 100.100.100.200 and fd00:ec2::254, unspecified, multicast, broadcast and IPv4-in-IPv6 forms stay refused for every host, and one refused answer refuses the whole name.
- The name is resolved and checked at every connect, and git/ssh are pinned to the checked address (`http.curloptResolve`; ssh `HostName` with `HostKeyAlias` for host-key verification). HTTP redirects are off, so DNS rebinding or a redirect cannot reach an address the check did not see. TLS certificates and SSH host keys are still verified against the name.
- The variable is operator configuration only; users cannot change it. **The trade-off:** any signed-in user can then make the server open HTTPS and SSH connections to the listed hosts (on any port in their URL) and read what a git client would see. List only git servers whose unauthenticated content every user may read, and keep private repositories on SSH keys.

## First administrator: private access before public exposure

The first administrator is created through `/signup` with an `ADMIN_EMAILS` address **and a one-time bootstrap token**:

- While no account exists and `ADMIN_EMAILS` is set, every server start prints a fresh token to the boot log, on lines starting with `[bootstrap]` (for example `docker compose -p cockpit-context logs app | grep '\[bootstrap\]'`). The signup form asks for it.
- The token is held in memory only and compared in constant time. A restart replaces it; the previous one stops working. It is never printed again once used.
- The bootstrap closes for good as soon as **any** account exists, with or without SMTP. A guessed listed address without the token gets the same refusal as any other address. Later administrators are invited or promoted from Admin → Users.
- If accounts exist but none is an administrator (for example an open-signup server where someone else signed up first), the bootstrap stays closed and the sign-in page says so. This release has no in-app recovery for that state: an administrator account has to be restored ([backup and restore](./backup-restore.md)), so keep `SIGNUP_ENABLED=false` until the administrator exists.
- With SMTP the new administrator still verifies the address by email; without SMTP the account is created verified.

Treat the boot log as secret until the first signup is done. The token makes a reachable form safe to leave up briefly, but finishing signup privately before routing the public domain is still the most conservative path. One concrete private setup uses a temporary local HTTPS origin:

1. Keep the public domain unrouted and public app ingress closed. Set `BETTER_AUTH_URL=https://localhost:8443`, `COCKPIT_CONTEXT_HTTP_PORT=3036`, your `ADMIN_EMAILS`, secrets and model settings.
2. On the host, start with the loopback overlay:

   ```sh
   docker compose -p cockpit-context -f compose.yaml -f compose.vps.yaml up -d --build
   ```

3. Run a temporary Caddy listener on the server, bound only to loopback:

   ```caddyfile
   https://localhost:8443 {
     bind 127.0.0.1
     tls internal
     reverse_proxy 127.0.0.1:3036
   }
   ```

4. From your workstation open the tunnel, using your own SSH destination:

   ```sh
   ssh -N -L 8443:127.0.0.1:8443 deploy@your-server
   ```

   Trust this Caddy instance's local CA in a temporary browser profile through a secure transfer, then visit `https://localhost:8443/en-US/signup`. Sign up using the configured allowlisted address and the `[bootstrap]` token from the app's log. Enroll administrator 2FA within the 24-hour grace period and store recovery codes securely.
5. Stop the app, change `BETTER_AUTH_URL` to the final public HTTPS origin, remove the temporary listener, configure public TLS routing, and recreate the app. Sign in again at the final origin; do not reuse an OAuth connection configured for the temporary origin.

For Dokploy, read the token from the app's deployment log. Prefer the same private bootstrap before adding its public domain: temporarily use the VPS loopback overlay or an equivalent private TLS tunnel to the selected app.

Keep `ADMIN_EMAILS` configured. It does not promote arbitrary existing accounts. Invite developers from Admin → Users: SMTP sends a one-time set-password link; without SMTP the administrator receives that link once to pass privately. A user who loses their password (on a server without SMTP, where “Forgot password?” cannot send mail) gets a new one-time link from Admin → Users → **Send password link…**. With SMTP it is emailed only to the user; if the send fails the link is revoked and the admin gets an error instead of the link. Without SMTP the administrator receives it once to pass privately. It is single use, expires in seven days, supersedes earlier links, is refused for administrators (demote first), archived and SSO-only accounts, and writes an `[audit]` line to the server log. Never share account passwords. Each developer adds their own packages. A dedicated harness account also needs its own packages and SSH access.

## Plain VPS with Caddy

Set `COCKPIT_CONTEXT_HTTP_PORT=3036` or another available loopback port; the overlay defaults to 3000, which may already be used by Dokploy. After private bootstrap, use your final origin and a public Caddy site:

```caddyfile
context.example.com {
  reverse_proxy 127.0.0.1:3036 {
    flush_interval -1
  }
}
```

Use your own domain, DNS and TLS configuration. Preserve `/mcp`, `/api/auth/*` and `/.well-known/*` paths and forwarded headers. Do not buffer SSE; allow requests to last at least `COCKPIT_CONTEXT_MCP_WAIT_SECONDS` (default 900 seconds). Keep app HTTP bound to loopback and the database unexposed.

## Dokploy Compose

Create a distinct Compose project for this repository, using `compose.yaml` alone. Its services have no host-port mappings. Set the production environment before first boot and finish the private administrator setup above. In the Dokploy domain UI add your domain for service **app**, container port **3000**, with HTTPS. Attach only the app to the proxy network through Dokploy's supported routing; keep Postgres on the project-private internal network. Do not attach the database to a shared proxy network or add a generic global `postgres` alias there.

Use a unique project name alongside WS Sandbox Proxy and Knowledge Base, and project-scoped networks/volumes. Keep one app replica and stop-first replacement. Configure proxy timeout/streaming for MCP. This is Dokploy **Compose**, not a separate Swarm Application or db-applier image.

### Response compression

The Node server ships no compression middleware; compression is the proxy's job. Traefik, Dokploy's proxy, has compression off by default, so SSR pages and JSON responses go out uncompressed until you attach a compress middleware to the app router (labels `traefik.http.middlewares.<name>.compress=true` and `traefik.http.routers.<router>.middlewares=<name>`, or the equivalent in Dokploy's domain settings). If you add compression to Caddy for the plain-VPS setup, test that MCP and live-view event streams (`text/event-stream`) still arrive unbuffered. `pnpm dokploy:verify` warns when the public site root is served uncompressed.

## Runtime checks and limits

Check `/health` for liveness and `/ready` for readiness after migrations, then sign in and run an actual dependency question. Admin → Settings reports model, storage and language-server sandbox status. To probe Landlock in the app:

```sh
docker compose -p cockpit-context exec app node apps/server/dist/lsp-sandbox-check.mjs
```

### Language-server sandbox

Landlock ABI 4+ provides the required network restrictions. Leave `COCKPIT_CONTEXT_LSP_SANDBOX=required`; without the helper/kernel protections, language-server tools are disabled and confined file tools still work. Do not relax container capabilities, seccomp or AppArmor to force LSP availability.

| Budget | Default |
|---|---|
| `COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS` | 4 globally |
| `COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER` | 3 main runs per user |
| `COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER` | 20 waiting main runs per user, then `BUSY` (0 = unlimited) |
| `COCKPIT_CONTEXT_MAX_ITERATIONS` / `COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS` | 100 iterations / 600 seconds |
| `COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR` | 30 per credential |
| `COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE` | 120 per credential |
| `COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR` | 120 per user across all credentials (0 = unlimited) |
| `COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED` / `_TTL_SECONDS` / `_MAX_ENTRIES` | On / 3600 / 500: owner-scoped MCP answer reuse ([mcp.md](./mcp.md#answer-reuse)) |
| `COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS` / `_MAX_ENTRIES` | 300 (0 = off) / 1000 exact-version resolutions |
| `COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER` | 10 waiting result requests |
| `COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER` | 20 web live streams |
| `COCKPIT_CONTEXT_MAX_STORAGE_GB` | 20 decimal GB (10^9 bytes per GB) |

Leave disk headroom for in-progress clones and PostgreSQL/backups beyond the cache budget. Pruning removes least-recently-used unleased caches. Summary runs count globally but not against the main-run per-user cap. Separate tokens do not create independent users or guarantee fairness between sandboxed agents. Read [product limits](./product.md#limits).

## Upgrades, migrations and backups

Before upgrading, read the changelog, take a verified backup, preserve keys and protect snapshot clones. Stop the old app and optional scheduler. Build/pull the reviewed version, then start one app so the startup runner applies pending committed migrations. With one-shot deployment, run image command `migrate` first and use `MIGRATE_ON_START=false` for the app. Never bypass startup admission or edit merged migration history to force an older image to run. PostgreSQL major upgrades need their own tested dump/restore plan; changing an image tag does not upgrade an existing data directory.

Configure the optional backup profile and test restore before relying on it. The scheduler defaults off, and an unconfigured pre-migration backup hook warns and skips dumping. See [schema migrations](./schema-migrations.md), [change recipes](./schema-changes-recipe.md) and [backup/restore](./backup-restore.md) for exact commands, confirmation and scope. A documentation/check pass is not proof of a successful deployment or production restore.

## Troubleshooting

If `/ready` fails, inspect app logs for migration admission or missing production settings. Do not bypass checks. A running UI without model credentials cannot answer dependency questions. Confirm the configured model is available to its OpenRouter key.

For missing LSP tools, run `node scripts/check-runtime-tools.mjs --require-sandbox` inside the app container and inspect Admin → Settings. The image includes the helper and language servers, but host Landlock enforcement depends on the kernel. Unsupported protection disables LSP; retain required mode.

For OAuth failures verify BETTER_AUTH_URL and the browser/client origin match, then check discovery/auth forwarding and proxy streaming. For a signup-closed first boot, set ADMIN_EMAILS and restart privately, then use the `[bootstrap]` token from the new boot log; do not open public signup as a workaround. A stale chunk uses the guarded recovery UI; a deployment should not add a second app replica to hide startup failure.
