# Hosting contract

Run exactly one application replica and PostgreSQL 18. The Node.js 26.13.1 application image serves the web UI, oRPC API and MCP endpoint, and executes background jobs and investigation runs in process. No Redis or separate worker is required. Replacement must stop the old app before starting the new one.

PostgreSQL stores accounts, access settings, package definitions, conversations, turns and job state. `/data` stores bare repositories and detached checkouts; `/backups` is a separate persistent dump volume. Normal clones/checkouts are cache, but a snapshot created with a one-time SSH key may be irreplaceable without another credential. Back up those bytes separately and retain the encryption keyring outside the database backup.

The application needs outbound access to public Git/SSH hosts, OpenRouter and optionally SMTP/S3/OIDC providers. PostgreSQL stays on a project-private internal network with the alias `cockpit-context-postgres`; it has no host port. The app additionally has an egress network. Each deployment uses a unique Compose project and project-scoped volumes/networks, without `container_name`.

`compose.yaml` publishes no host ports and supports Dokploy Compose domain routing to app port 3000. Plain VPS installs add `compose.vps.yaml` for loopback HTTP behind a TLS proxy. See [deployment](./deploy.md), [migrations](./schema-migrations.md) and [backup/restore](./backup-restore.md).
