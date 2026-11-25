# Deploy Cockpit Context

## Topology and prerequisites

Use Docker Compose on a Linux host: one Node.js 26.13.1 app container and PostgreSQL 18 (the pinned image is 18.6). There is no Redis or standalone job worker. Run exactly one app replica and use stop-first replacement; in-process event delivery, rate limiters and concurrency are not distributed. See [hosting](./hosting.md).

`compose.yaml` publishes no ports. PostgreSQL lives only on the project-private internal network with alias `cockpit-context-postgres`. App port 3000 is for the reverse proxy. PostgreSQL 18 mounts its parent `/var/lib/postgresql`, with PGDATA `/var/lib/postgresql/18/docker`. `/data` has a persistent volume. Backup storage is opt-in.

Clone the public repository and use a unique project name such as `cockpit-context` on a server also running other services. Do not add `container_name` or global volume/network names. This keeps it separate from WS Sandbox Proxy and Knowledge Base, including their databases.

```sh
git clone https://github.com/FlyCockpit/context.git
cd context
cp .env.example .env
```

Edit `.env` privately. Generated examples contain placeholders, not deployment credentials. Do not use `.env.docker.defaults` for production. The supplied Compose file builds `Dockerfile` locally. No release image has been published yet; the manual Release workflow publishes each release as `ghcr.io/flycockpit/context:<version>`. To use a published image once one exists, override the app and optional backup image consistently and pull the selected release; prefer a digest for immutable deployments.

A first deployment needs only `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `COCKPIT_CONTEXT_ENCRYPTION_KEYS` and `ADMIN_EMAILS`, plus `TRUST_PROXY_HOPS=1` behind Traefik/Dokploy or Caddy (the default `0` keys every request on the proxy). Compose supplies the database URL, production mode, storage path and migration defaults. Model credentials are needed when you want real answers. No backup settings, backup volume or scheduler are required: migrations run without a backup, and startup logs one notice explaining how to opt in.

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
| `TRUST_PROXY_HOPS` | Defaults to **0**: use the socket peer and ignore forwarded headers (direct deployment). Set **N** to the exact number of trusted proxies, e.g. **1** behind Traefik/Dokploy, Caddy or a Cloudflare Tunnel to the app, **2** for a tunnel into Traefik/Caddy ([Cloudflare Tunnel](#home-server-behind-a-cloudflare-tunnel)). Restrict origin access to that chain. Only the Nth entry from the right of X-Forwarded-For is used; a missing/invalid hop falls back to the socket peer. A proxy-appended IPv4 or bracketed IPv6 port is stripped. |
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

1. Keep the public domain unrouted and public app ingress closed. Set `BETTER_AUTH_URL=https://localhost:8443`, `COCKPIT_CONTEXT_HTTP_PORT=3036`, `TRUST_PROXY_HOPS=1` for the Caddy proxy, your `ADMIN_EMAILS`, secrets and model settings.
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

No public IP (a home server behind NAT or CGNAT)? Put a Cloudflare Tunnel in front instead of a public Caddy site: [Home server behind a Cloudflare Tunnel](#home-server-behind-a-cloudflare-tunnel).

## Dokploy Compose

Create a distinct Compose project for this repository, using `compose.yaml` alone. Its services have no host-port mappings. Set the production environment before first boot and finish the private administrator setup above. In the Dokploy domain UI add your domain for service **app**, container port **3000**, with HTTPS. **Set `TRUST_PROXY_HOPS=1` yourself** in the Compose environment: this repository has no Dokploy config generator to set it, and the default `0` (direct deployment) makes every request behind Traefik look like it comes from the proxy, so per-IP rate limits and sign-in failure limits would be shared by all clients. Count any additional trusted proxy in front of Traefik too. Attach only the app to the proxy network through Dokploy's supported routing; keep Postgres on the project-private internal network. Do not attach the database to a shared proxy network or add a generic global `postgres` alias there.

Use a unique project name alongside WS Sandbox Proxy and Knowledge Base, and project-scoped networks/volumes. Keep one app replica and stop-first replacement. Configure proxy timeout/streaming for MCP. This is Dokploy **Compose**, not a separate Swarm Application or db-applier image.

### Compose source: Git repository or raw file

There is no Dokploy config generator; pick one of two sources for the Compose service.

- **Git source (simplest).** Connect this repository with Compose path `compose.yaml` and your branch. Dokploy clones it on every deploy and builds `context: .`; the clone's `.git/HEAD` gives the image its commit, so `/ready` reports it for `pnpm deploy:check`. Put the settings above in the compose's **Environment** tab (Dokploy writes them to the `.env` that `compose.yaml` reads), plus `COMPOSE_PROFILES=backup` when you run the backup scheduler. Dokploy takes one Compose file, so `compose.backup.yaml` cannot be added here: give the app S3 for its pre-migration dumps, or use the raw form with the overlay merged in. Auto-deploy follows the branch.
- **Raw file (pinned Git context).** Paste a Compose file when the server needs its own edits (an extra network, Traefik labels). Start from `compose.yaml` as it is (for app-local dumps, copy in `compose.backup.yaml`'s two additions: the app's `/backups` volume and the scheduler's `depends_on: app`), keep its `${…}` references and put the settings in the **Environment** tab, so no secret is stored in the file. A pasted file has no source tree, so set the app's build context to the repository pinned to a full commit SHA, and keep `.git` in that build so the image can still read its commit:

  ```yaml
  services:
    app:
      build:
        context: "https://github.com/FlyCockpit/context.git#<full commit SHA>"
        args:
          BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
  ```

  Without the build arg, a Git context drops `.git` and `/ready` reports `commit: null` unless `BUILD_VERSION` is set to the same full SHA. The Dokploy server's Docker fetches the context itself, so the repository must be reachable from there (public, or an SSH URL whose key that Docker can use). Never put a token in the URL: the file is stored in Dokploy. The `backup` service runs the image the app service builds. To release, change the SHA and deploy; a raw file does not follow the branch.

### Response compression

The Node server ships no compression middleware; compression is the proxy's job. Traefik, Dokploy's proxy, has compression off by default, so SSR pages and JSON responses go out uncompressed until you attach a compress middleware to the app router (labels `traefik.http.middlewares.<name>.compress=true` and `traefik.http.routers.<router>.middlewares=<name>`, or the equivalent in Dokploy's domain settings). If you add compression to Caddy for the plain-VPS setup, test that MCP and live-view event streams (`text/event-stream`) still arrive unbuffered. `pnpm dokploy:verify` warns when the public site root is served uncompressed.

### Static asset caching

Files under `/assets/` are content-hashed and served with `Cache-Control: public, max-age=31536000, immutable`; a missing file there is a plain `404` with `Cache-Control: no-store` and no locale redirect. SSR pages and the HTML shell get no long-lived cache header (public pages are held only in the server's own memory cache for `SSR_CACHE_TTL_SECONDS`, default 60 s), so do not add one at a CDN or proxy: a new deploy's hashed assets are reached through the current HTML.

## Home server behind a Cloudflare Tunnel

A machine at home with no public IP can serve Cockpit Context through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (a named tunnel run by `cloudflared`, Free or Pro plan). Nothing needs inbound TCP or UDP: `cloudflared` makes outbound connections to Cloudflare, Cloudflare terminates TLS for your hostname, and requests reach the app as plain HTTP over loopback or a private network. The app itself still needs the outbound access in [hosting](./hosting.md) (Git/SSH hosts, OpenRouter, SMTP).

There are two topologies. The hop count differs between them:

- **Tunnel to the app.** Browser or coding agent → Cloudflare edge (TLS) → `cloudflared` on the home machine → `http://127.0.0.1:<port>` → app. One proxy hop, `TRUST_PROXY_HOPS=1`.
- **Tunnel to a local proxy.** Browser or coding agent → Cloudflare edge → `cloudflared` → Traefik (Dokploy) or Caddy on plain HTTP → app. Two hops, `TRUST_PROXY_HOPS=2`. The local proxy must trust `cloudflared`'s address for forwarded headers, or it replaces the client's `X-Forwarded-For` entry with `cloudflared`'s and every user shares one rate-limit bucket.

Start the app with the loopback overlay as in [Plain VPS with Caddy](#plain-vps-with-caddy) (`compose.vps.yaml` publishes `127.0.0.1:${COCKPIT_CONTEXT_HTTP_PORT}` only), or run `cloudflared` as a container on the app's network and point it at `http://app:3000` with no published port at all. Do not publish the app on `0.0.0.0` or forward a router port to it. The tunnel must be the only way in: `TRUST_PROXY_HOPS` trusts the rightmost `X-Forwarded-For` entries, so a caller who reaches the origin directly can choose their own rate-limit key.

A sample `/etc/cloudflared/config.yml` for the first topology (create the tunnel and its DNS route with `cloudflared tunnel create` and `cloudflared tunnel route dns`, and substitute your tunnel id and hostname):

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: context.example.com
    service: http://127.0.0.1:3036
  - service: http_status:404
```

For the second topology, point the service at the local proxy (for example `http://127.0.0.1:80`). `cloudflared` keeps the original `Host` header, so the proxy routes by your hostname as usual.

Create the named tunnel either way:

- **Remotely managed** (simplest): create it in the Cloudflare Zero Trust dashboard, add the public hostname there (`context.example.com` → `http://127.0.0.1:3036` for a connector on the host, `http://app:3000` for a connector container on the app's network), and run the connector with the tunnel token. The token is the only secret: keep it with the deployment's other secrets, never in a file in the checkout.
- **Locally managed**: `cloudflared tunnel login`, `cloudflared tunnel create`, `cloudflared tunnel route dns`, then the `config.yml` above. Keep it and the credentials JSON **outside the checkout** (for example in `/etc/cloudflared` on the host): the image build copies the whole checkout (`COPY . .`) and `.dockerignore` does not exclude a `cloudflared/` folder, so a credentials file inside the checkout would end up in the build layers. The official `cloudflare/cloudflared` image runs as the unprivileged UID 65532 and `cloudflared tunnel create` writes the credentials file readable by its owner only, so for a connector container hand both to that UID, naming the file: `sudo chmod 400 /etc/cloudflared/<tunnel-uuid>.json`, then `sudo chown -R 65532:65532 /etc/cloudflared` and `sudo chmod 700 /etc/cloudflared`. Without that the container cannot read the file and the tunnel never connects.

A connector container on the app's `egress` network (the app's other network, `internal`, has no outbound access), added to the Compose project with no published port at all; point the ingress at `http://app:3000`:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:<version>   # pin a version you have tested
    command: tunnel --no-autoupdate run
    # Remotely managed: no volume; pass the token instead.
    #   environment:
    #     TUNNEL_TOKEN: ${CLOUDFLARED_TUNNEL_TOKEN:?set with the other secrets}
    volumes:
      - /etc/cloudflared:/etc/cloudflared:ro
    depends_on: [app]
    networks: [egress]   # the app's non-internal network: reaches `app` and Cloudflare
    restart: unless-stopped
```

| Setting | Tunnel to the app | Tunnel to Traefik/Caddy |
|---|---|---|
| `BETTER_AUTH_URL` | `https://context.example.com` | `https://context.example.com` |
| `TRUST_PROXY_HOPS` | `1` | `2` |
| `COCKPIT_CONTEXT_HTTP_PORT` | a free loopback port, e.g. `3036`, with `compose.vps.yaml` | as your proxy setup requires |
| `CORS_ORIGIN` | unset (same origin) | unset (same origin) |
| `SMTP_HOST` / `SMTP_PORT` | a relay on `587` (STARTTLS) or `465` (implicit TLS) | same |

`BETTER_AUTH_URL` is the one public-URL setting: sign-in, cookies, emailed links, the allowed browser origin and every MCP OAuth URL (issuer `<origin>/api/auth`, resource `<origin>/mcp`) come from it, so it must be the tunnel hostname exactly. `CORS_ORIGIN` is only for a browser app on a different origin. `PUBLIC_APP_URL` is translation-provider metadata, not used for authentication. Home connections usually block outbound port 25, so send mail through a relay (your provider's SMTP submission service) on 587 or 465. With port 465 the mailer uses implicit TLS on its own. `pnpm doctor:app` warns when `TRUST_PROXY_HOPS` is `0` on a deployment (`NODE_ENV=production`, or an `https` `BETTER_AUTH_URL` on a non-local host), and the server logs one `[client-ip]` warning when a private peer such as `cloudflared` sends `X-Forwarded-For` while it is `0`.

**Client address.** Cloudflare appends the address that connected to it to `X-Forwarded-For`, and `cloudflared` forwards that header unchanged, so with the hop counts above the app keys rate limits and sign-in failures on the real client. The app does not read `CF-Connecting-IP`. That header names the same address, but trusting it is safe only while nothing but the tunnel can reach the origin, and it would stay trusted if the deployment later moved behind another proxy. One rule (count the hops in `X-Forwarded-For`) covers every topology. For the two-hop topology:

- **Traefik:** add `cloudflared`'s address to the `web` entry point's `forwardedHeaders.trustedIPs`. A host `cloudflared` reaching a Traefik container through a published port arrives from the Docker bridge gateway (such as `172.17.0.1`), not from `127.0.0.1`.
- **Caddy:** list it under the global `servers { trusted_proxies static … }` option and serve the site as `http://context.example.com` (or `:80`).

**Limits that apply.**

- **Request bodies.** Cloudflare caps request bodies at 100 MB on Free and Pro plans. Cockpit Context never needs that much: the server refuses any body over 10 MB, `/mcp` over 1 MB, the OAuth authorize and token forms over 16 KB and consent and client registration over 32 KB, and backups and restores never pass through the tunnel.
- **Silent responses (524).** Cloudflare answers 524 when the origin sends nothing for its Proxy Read Timeout: 125 s by default on Free and Pro, adjustable only on Enterprise (it was 100 s for years, so plan for 100 s). The two long-lived responses stream a keepalive: an MCP tool call is a server-sent event stream with a `: keepalive` comment every 15 s from dispatch to result, whatever the investigation is doing (`query_dependency` and `get_query_result` can wait up to `COCKPIT_CONTEXT_MCP_WAIT_SECONDS`, 900 s by default). The web live view (`conversations.watch` and `.activity`) sends the same comment every 15 s.
- **Long web actions run in the background.** No web request waits on a clone, a fetch or a slow mail relay for longer than a bounded time, so none of them ends in a 524:
  - Starting a conversation from the web form answers at once. The conversation opens, and its first run resolves the version on the server: the first clone of a large repository, or a fetch, shows its progress in the conversation ("Cloning the repository…", with the elapsed time). Closing the browser does not stop it, Stop does, and a restart interrupts it. If the version cannot be found or fetched, the conversation says why and offers **Try again**; an unknown version also lists the nearest tags, each one a retry on that tag. The work belongs to the run, so the repository lock, the per-user preparation limit and the shared clone of a public repository apply as for any run.
  - Adding, approving or updating a snapshot package (a one-time SSH key) answers at once. The clone or refresh runs in the background and the package page shows its progress and outcome. The pasted key is held only in the server's memory, never in a job or the database, so a restart cancels the work: the package then asks for the key again. Deleting the package cancels a clone that is still running.
  - Deleting a clone or checkout (Admin → Storage, a package's checkouts), a snapshot package or a user (Admin → Users, which removes their private clones; 30 s across all of them) waits at most 10 s for a clone or fetch of that repository to finish, then answers "busy, try again in a few minutes" (a user stays blocked meanwhile). A snapshot's own clone or refresh is cancelled first. A deleted clone or worktree is renamed out of the way at once and its files are removed in the background.
  - Every mail send has one 40 s budget across its retries (15 s for the login page's mail check), and its connection is closed when the budget runs out. Invitations and password links still report a failed send (a second password link for the same user while one is being sent is refused, not queued); the two-factor sign-in code is sent after the response.

  A stale-work sweep every 5 minutes closes any run or snapshot task still marked active that no running task owns (normally only possible after a crash, which boot recovery also handles), so nothing stays "preparing" for ever.

**Dropped streams.** Cloudflare can close a long-lived connection when its edge restarts. Cockpit Context uses no WebSockets: the live view is a server-sent event stream that reconnects on its own (after 1 s, backing off to at most 30 s between attempts), and every reconnect starts from a fresh snapshot, so nothing is lost. An MCP call whose stream drops ends with a transport error in the coding agent. An investigation that had already started keeps running, and asking the same question again joins it or reuses its answer ([answer reuse](./mcp.md#answer-reuse)). A drop while an MCP call is still resolving the version cancels that clone or fetch (a web conversation resolves inside its run, so a dropped live view changes nothing).

**Not needed.** Opening ports 80/443, a static IP or a DDNS client (the tunnel follows the machine wherever it connects from). ACME and certificate settings (Traefik `certresolver` labels, Dokploy's HTTPS/Let's Encrypt toggle, Caddy's automatic HTTPS) do not apply. Cloudflare holds the certificate for your hostname, so nothing behind the tunnel needs one. Serve the local proxy on plain HTTP, and do not let it redirect to HTTPS: Cloudflare already did, and the redirect would loop. Do not put a Cloudflare challenge (Bot Fight Mode, a managed challenge or Cloudflare Access) in front of `/mcp`, `/.well-known/*` or `/api/auth/*`: coding agents are not browsers and cannot pass one.

## Runtime checks and limits

Check `/health` for liveness and `/ready` for readiness after migrations, then sign in and run an actual dependency question. From your computer, `pnpm deploy:check https://<your-app> --commit <sha>` confirms the release that is live. On the host, from a checkout, `pnpm dokploy:verify --project <compose project> --url https://<your-app> --commit <sha>` waits (up to `--timeout-seconds`, default 600) until the project's single `app` container runs healthy and was built from that commit (its baked `BUILD_COMMIT`), and `/ready` passes and reports the same commit, so an earlier release a failed redeploy left running never passes. It fails on a missing or second app container (`docker compose run` one-offs do not count), an unhealthy, exited or restarting one, or a container replaced while it watches, and it reads only container labels, state and that commit file, never environment or logs. Dokploy's Compose project name is the compose's app name (shown in its settings); for the plain VPS setup it is `cockpit-context`. Admin → Settings reports model, storage and language-server sandbox status. To probe Landlock in the app:

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
| `COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS` / `COCKPIT_CONTEXT_MAX_HELPERS` | 5 helper agents at once / 10 in total per investigation, across all its `delegate_explore` calls; one call starts 2 up to the parallel limit, a call past the total runs only what is left. Each helper is billed model spend. A parallel limit above the total is lowered to it with a startup warning |
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

Before upgrading, read the changelog, preserve keys and protect snapshot clones. A verified backup is recommended and remains an operator opt-in. Stop the old app and optional scheduler. Build/pull the reviewed version, then start one app so the startup runner applies pending committed migrations. With one-shot deployment, run image command `migrate` first and use `MIGRATE_ON_START=false` for the app. Never bypass startup admission or edit merged migration history to force an older image to run. PostgreSQL major upgrades need their own tested dump/restore plan; changing an image tag does not upgrade an existing data directory.

Backups default off (`BACKUP_ENABLED=false`, `BACKUP_SCHEDULE=off`): migration and pre-drop hooks are skipped, readiness stays healthy, and one startup notice (`NOTICE: [backup] Backups are OFF …`, printed by the entrypoint's backups check for the app and for a `migrate` job alike) explains how to enable backups. To opt in, configure storage and `BACKUP_ENABLED=true`; add `compose.backup.yaml` for local app dumps and profile `backup` with `BACKUP_SCHEDULE=daily` for the scheduler. `BACKUP_ENABLED` is strict: any value other than `true`/`false` stops the start. With `true`, every migrating start (the app with `MIGRATE_ON_START=true`, or the `migrate` job) first checks for a usable destination (a writable `/backups` mount and/or valid `BACKUP_S3_*` settings) and fails without one, even when nothing is pending and on a brand-new database; the runner then requires the pre-migration dump (a failed dump refuses the migration) and the pre-drop dump (a failed one skips that start's scheduled deletions). With backups off, a configured but unused destination gets a startup warning in place of that notice. The manual `backup` command, the daily service and the pre-restore snapshot need a destination whatever the switch says. Test restore before relying on backups.

The image's entrypoint is PID 1 while it validates the environment, runs the startup check and the migration runner (both as supervised children: a `docker stop` during them stops them and exits 143, 130 for INT, 129 for HUP, and the app never starts). Only that phase sees the dump-writer keys `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`: the entrypoint then unsets them and execs `tini` with the server, so `/proc/1/environ` and the server's environment are clean. The non-secret `BACKUP_S3_*` location settings stay for the freshness monitor, which uses its own ListBucket-only `BACKUP_MONITOR_S3_*` key. One-shot commands (`migrate`, `backup`, `backup-schedule`, `restore`, `restore-drill`, `hold-deletions`) run under `tini` and keep the writer keys. Docker's container configuration (`docker inspect`, a `docker exec` shell) still contains every configured variable; unsetting them in the process is not removal from container metadata. See [schema migrations](./schema-migrations.md), [change recipes](./schema-changes-recipe.md) and [backup/restore](./backup-restore.md) for exact commands, confirmation and scope. A documentation/check pass is not proof of a successful deployment or production restore.

## Troubleshooting

If `/ready` fails, inspect app logs for migration admission or missing production settings. Do not bypass checks. A running UI without model credentials cannot answer dependency questions. Confirm the configured model is available to its OpenRouter key.

For missing LSP tools, run `node scripts/check-runtime-tools.mjs --require-sandbox` inside the app container and inspect Admin → Settings. The image includes the helper and language servers, but host Landlock enforcement depends on the kernel. Unsupported protection disables LSP; retain required mode.

For OAuth failures verify BETTER_AUTH_URL and the browser/client origin match, then check discovery/auth forwarding and proxy streaming. For a signup-closed first boot, set ADMIN_EMAILS and restart privately, then use the `[bootstrap]` token from the new boot log; do not open public signup as a workaround. A stale chunk uses the guarded recovery UI; a deployment should not add a second app replica to hide startup failure.
