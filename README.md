<p align="center">
  <img src=".github/assets/logo.png" alt="" width="160" height="160">
</p>

<h1 align="center">Cockpit Context</h1>

<p align="center">Dependency answers for AI coding agents, read from real source.</p>

<p align="center">
  <a href="LICENSE"><img src="https://shieldcn.dev/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/FlyCockpit/context/releases"><img src="https://shieldcn.dev/github/FlyCockpit/context/release.svg" alt="GitHub release"></a>
  <a href="https://nodejs.org"><img src="https://shieldcn.dev/badge/Node.js-26.13.1-339933.svg?logo=nodedotjs" alt="Node.js 26.13.1"></a>
  <a href="https://react.dev"><img src="https://shieldcn.dev/badge/React-19-087EA4.svg?logo=react" alt="React 19"></a>
  <a href="https://tanstack.com"><img src="https://shieldcn.dev/badge/TanStack-Router%20%C2%B7%20Query-FF4154.svg?logo=tanstack" alt="TanStack Router and Query"></a>
  <a href="https://hono.dev"><img src="https://shieldcn.dev/badge/Hono-oRPC-E36002.svg?logo=hono" alt="Hono with oRPC"></a>
  <a href="https://www.prisma.io"><img src="https://shieldcn.dev/badge/Prisma-PostgreSQL-2D3748.svg?logo=prisma" alt="Prisma and PostgreSQL"></a>
  <a href="https://www.better-auth.com"><img src="https://shieldcn.dev/badge/Better--Auth-2FA%20%C2%B7%20SSO-0F172A.svg?logo=betterauth" alt="Better Auth with 2FA and optional configured SSO"></a>
  <a href="https://tailwindcss.com"><img src="https://shieldcn.dev/badge/Tailwind%20CSS-v4-06B6D4.svg?logo=tailwindcss" alt="Tailwind CSS v4"></a>
  <a href="https://github.com/FlyCockpit"><img src="https://shieldcn.dev/badge/part%20of-FlyCockpit-0ea5e9.svg" alt="Part of FlyCockpit"></a>
</p>

Cockpit Context lets coding agents ask questions about dependencies and get answers grounded in their actual source code at the requested version or Git ref. An investigation agent reads the checkout, follows relevant code and returns its findings over MCP.

Deploy one instance for your developers or agent harness. Each user manages their own packages, credentials and conversations. Public repository clones and checkout overviews can be reused to save work; private SSH repositories remain scoped to their owner. The web dashboard lets you watch an investigation, steer it, stop it and continue the conversation.

## Features

- **Source at the version you use.** Resolve package versions and Git refs to commits, with monorepo subdirectories and configurable tag patterns.
- **Investigations over MCP.** Connect using OAuth or a revocable API token. Agents can query approved packages and, when permitted, propose additions for human approval.
- **Live control.** Watch saved investigation turns, send guidance, stop runs and ask follow-up questions in the web dashboard.
- **Private dependencies.** Use encrypted saved SSH keys or private snapshots created with a one-time key.
- **Bounded resource use.** Configure run concurrency, time and rate budgets, storage pruning and conversation retention.
- **Self-hosted dashboard.** Administrator controls, localized routes and an installable PWA, with optional SMTP and configured OIDC SSO.

## How it works

The React web app and MCP clients connect to a Hono server. PostgreSQL stores accounts, package configuration, conversations, runs and background jobs. One application process runs the investigation engine and background jobs; repositories and checkouts live on a persistent data volume. No Redis or separate worker is required. Run exactly one app replica, including during deployment replacement.

Investigations use OpenRouter for model inference. They read dependency source through confined file-search/read tools and can use TypeScript/JavaScript and Python language servers. On supported Linux hosts, the language servers run under Landlock confinement; when the required sandbox is unavailable those tools are disabled and file-based investigation remains available. Source excerpts and questions sent to the model leave the instance, so choose a provider and model appropriate for your data.

Repository reuse does not share users' conversations or imply a cross-user answer cache. Named organizational workspaces and separate service-account identities are not part of the documented 1.0.0 model; credentials act as the user who authorizes them.

## Quick start

Install Node.js 26.13.1, Docker or Podman and user-managed `portless` (`npm install -g portless`). Install repository-pinned pnpm 12 with its verified installer:

```sh
git clone https://github.com/FlyCockpit/context.git
cd cockpit-context
node scripts/install-pnpm.mjs package.json "$HOME/.local/bin" "$HOME/.local/share/cockpit-context"
export PATH="$HOME/.local/bin:$PATH"
pnpm install
pnpm run setup
```

Setup prepares local env files, secrets, services and migrations and records your bootstrap admin email. Configure `OPENROUTER_API_KEY` and `COCKPIT_CONTEXT_MODEL` privately, then run `pnpm dev`. Open the configured local HTTPS origin, sign up using your bootstrap address and the `[bootstrap]` token from the server output, verify in development Mailpit when configured, and enroll administrator 2FA. Add a dependency under Packages and connect a client using [the MCP guide](./docs/mcp.md#first-question).

## Installation

For production use [the deployment guide](./docs/deploy.md). It covers PostgreSQL 18, the single Node.js 26.13.1 app image, private first signup, Dokploy Compose domain routing and the optional VPS loopback overlay with Caddy. Set `ADMIN_EMAILS` before first boot; the first signup also needs the one-time `[bootstrap]` token printed to the boot log. Keep one app replica.

## Configuration

Required production inputs include `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, the exact HTTPS `BETTER_AUTH_URL`, `ADMIN_EMAILS` and `COCKPIT_CONTEXT_ENCRYPTION_KEYS`. Real investigations also require `OPENROUTER_API_KEY` and `COCKPIT_CONTEXT_MODEL`. Optional SMTP enables verification and email resets/invites; optional OIDC SSO requires provider configuration.

Keep signup closed by default and invite developers. Configure storage/concurrency budgets, retention, proxy hops and backups for your deployment. Source excerpts and questions may be sent to your model provider. See [all operator settings](./docs/deploy.md#configuration) and [backup/key custody](./docs/backup-restore.md).

## Usage

Add packages with their source URL, version/ref and optional monorepo subdirectory. Connect Claude Code or Codex through OAuth or a revocable API token, call `list_dependencies`, then `query_dependency`. Retain the query ID and poll `get_query_result` if the wait ends before completion. Watch, steer or stop runs in the web dashboard.

An organization can serve all its developers from one instance, but package lists and conversations remain per user. For a harness with many sandboxed agents, create a dedicated ordinary user account and its own token. Tokens are per user and share that user's limits. Public clones, checkouts and generated overviews are reused; completed answers are not cached. See [product limits](./docs/product.md#limits) and [harness setup](./docs/mcp.md#agent-harnesses).

## Development

React 19/TanStack in `apps/web`, Hono/oRPC/MCP in `apps/server`, and shared packages for Git, investigation tools, runs, jobs, auth, database and UI. Background jobs run in-process; there is no Redis or separate worker.

Read [CONTRIBUTING.md](./CONTRIBUTING.md), [AGENTS.md](./AGENTS.md) and [development conventions](./docs/development.md). Run `pnpm verify:fast` before handoff; full `pnpm verify` runs in CI/release. Schema changes use [committed migrations](./docs/schema-migrations.md), not schema push. Never use production credentials in development.

## Documentation

- [Product model and limits](./docs/product.md)
- [Access matrix](./docs/access-matrix.md)
- [Deployment and configuration](./docs/deploy.md)
- [MCP clients and tools](./docs/mcp.md)
- [Hosting and persistent storage](./docs/hosting.md)
- [Schema migrations](./docs/schema-migrations.md) and [change recipes](./docs/schema-changes-recipe.md)
- [Backup and restore](./docs/backup-restore.md)
- [Changelog](./CHANGELOG.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Keep changes focused and report the checks you ran.

## Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/FlyCockpit/context/security/advisories/new). See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). Copyright (c) 2026 FlyCockpit LLC. See [third-party notices](./THIRD-PARTY-LICENSES.md) for components distributed under their own licenses.
