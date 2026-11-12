# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/FlyCockpit/context/security/advisories/new). Do not open a public issue or attach credentials, private source or user conversations. Include affected version, impact and a minimal reproduction using synthetic data. We aim to acknowledge reports within 72 hours.

## Supported versions

Security fixes target the latest release and main. There are no long-term support branches. Operators should follow releases and update promptly, preserving tested backups and recovery keys.

## Security boundaries

Cockpit Context uses owner-scoped queries, protected admin procedures, revocable per-user MCP credentials, encrypted saved SSH keys, checked Git/SSH destinations and confined source-reading tools. The default LSP policy requires Landlock; unsupported hosts disable those tools. A strict CSP, separate rate budgets and production env validation provide additional controls. None of these makes untrusted dependency text or model output safe to execute automatically.

MCP credentials authorize tools for their owning user, not browser or admin APIs. Public clone/checkouts/generated overviews can be shared, while private SSH repositories and conversations are owner-scoped. Administrators see repository storage metadata but have no implicit access to others' conversations/keys. Infrastructure operators control the underlying host and database. Source excerpts and questions can be sent to OpenRouter/model providers. See [product boundaries](./docs/product.md) and the [access matrix](./docs/access-matrix.md).

## Operator responsibilities

Run one app replica behind HTTPS and a correctly configured trusted proxy. Keep PostgreSQL private, signup closed unless intentionally opened, and complete the initial no-SMTP admin signup over private access before exposing the domain. SMTP enables email verification; without it, email ownership is not proven. Enroll administrator 2FA. Protect the encryption keyring and auth secret separately from database dumps, and protect one-time-key snapshot clones with a separate volume snapshot. See [deployment](./docs/deploy.md) and [backup/restore](./docs/backup-restore.md).

## Repository checks

The repository includes seven-day pnpm release-age/build-script controls, pinned Actions, secret scanning, dependency audit and container scanning workflows. Their coverage depends on running the configured workflows; checks are not a security guarantee. The runtime is a single non-root app image, without a standalone worker. Contributor safety rules live in [AGENTS.md](./AGENTS.md).
