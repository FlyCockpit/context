# Connecting coding agents (MCP)

Cockpit Context exposes its investigation agent to coding agents (Claude Code, Codex, Cursor, …) over the Model Context Protocol at `/mcp` on your Cockpit Context origin, for example `https://context.example.com/mcp`. A client connects as you, with either an **API token** or **OAuth**, and can only use the MCP tools below. It never reaches the web app's procedures, settings, keys or tokens.

See the [product model](./product.md) and [access matrix](./access-matrix.md) for ownership boundaries.

Tokens and OAuth connections are managed in Cockpit Context under **Access → MCP tokens** and **Access → Connections**.

## Tools

| Tool | What it does |
|---|---|
| `list_dependencies` | Your packages: `identifier`, `display_name`, `ecosystem`, `default_ref`, and the versions already checked out |
| `query_dependency` | `{ identifier, question, version?, ref?, wait_seconds? }`: resolves the version (cloning or fetching if needed), starts an investigation, sends progress about every 20 s, and waits up to `wait_seconds` (default and maximum `COCKPIT_CONTEXT_MCP_WAIT_SECONDS`, 900). Returns `status: "completed"` with the `answer` and `version_resolved: { sha, from }`, or `status: "running"` with a `query_id`. If a branch fetch failed and cached refs were used, `version_resolved.stale` is true with `fetched_at`; decide whether that source is fresh enough before relying on it |
| `get_query_result` | `{ query_id, wait_seconds? }`: waits for a running query and returns its answer |
| `propose_dependency` | `{ ecosystem, name, git_url?, version?, reason }`: asks you to add a package. It waits for your approval on the Proposals page unless the connection auto-approves (never for a package that needs an SSH key) |
| `get_proposal` | `{ proposal_id }`: `pending`, `approved` (with the identifier) or `rejected` (with your reason) |

`propose_dependency` and `get_proposal` are hidden from a connection whose "may propose packages" flag is off.

Each connection may make `COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR` queries per hour (default 30) and `COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE` tool calls per minute (default 120). Every token and OAuth connection has its own budget, and a person is also capped across all of their connections by `COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR` (default 120; 0 turns it off). A query refused by that per-person cap does not use up the connection's own budget; it answers `QUERY_LIMIT` with `retry_after_seconds`. One person may also have at most `COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER` questions (default 20; 0 = unlimited) waiting for an investigation slot at once, web and MCP together; past it `query_dependency` answers `BUSY` (wait for some answers with `get_query_result`, then ask again). No role is exempt from either cap. The other MCP rate budgets (requests per IP and per credential, OAuth, consent, client registration) and every per-person budget are listed in [deploy.md](./deploy.md) and on **Admin → Settings → Rate limits**.

## Claude Code

### With an API token

1. In Cockpit Context, create an API token (Access → MCP tokens). Choose a name, an optional expiry, and whether the agent may propose packages and whether its proposals are auto-approved. The token (`<API_TOKEN>`) is shown once.
2. Add the server:

   ```bash
   claude mcp add --transport http cockpit-context https://context.example.com/mcp \
     --header "Authorization: Bearer <API_TOKEN>"
   ```

   Add `--scope user` to use it in every project, or `--scope project` to write it to the project's `.mcp.json` (do not commit a token: use an environment variable there, `"Authorization": "Bearer ${COCKPIT_CONTEXT_TOKEN}"`).

3. Check it with `/mcp` inside Claude Code: `cockpit-context` should be connected with five tools (three if proposing is off).

Revoking the token in Cockpit Context stops it at once.

### With OAuth (no token to copy)

```bash
claude mcp add --transport http cockpit-context https://context.example.com/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate** for `cockpit-context`. Claude Code discovers Cockpit Context's authorization server (`/.well-known/oauth-protected-resource/mcp`), registers itself, and opens your browser:

1. Sign in to Cockpit Context (the MCP sign-in page).
2. On the consent page, check the client name and the host the browser returns to (`localhost:<port>` for Claude Code), and choose whether the agent may propose packages and whether its proposals are auto-approved.
3. Allow. The browser returns to Claude Code, which stores the tokens and refreshes them itself (access tokens last 10 minutes, refresh tokens 72 hours of inactivity).

The connection appears in Cockpit Context under Access → Connections, where you can change its flags or revoke it. A revoked connection is refused at once; to reconnect, authenticate again (you will be asked to sign in again).

## Codex

The following flags were verified with `codex mcp add --help`. Codex uses its own MCP configuration, not generic `mcpServers` JSON. See [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

With an API token, put the token in `COCKPIT_CONTEXT_TOKEN` using your client or harness secret injection (do not commit it), then run:

```sh
codex mcp add cockpit-context --url https://context.example.com/mcp \
  --bearer-token-env-var COCKPIT_CONTEXT_TOKEN
codex mcp list
```

For OAuth, omit the bearer option and authenticate:

```sh
codex mcp add cockpit-context --url https://context.example.com/mcp
codex mcp login cockpit-context
```

Review the consent page and store credentials using the client's supported secret storage. Use one authentication method per configured server.

## First question

1. In the web dashboard, add a package (for example `npm:react`) and confirm its source URL and default ref.
2. Connect and authorize your client, then call `list_dependencies` and use the returned identifier.
3. Call `query_dependency` with that identifier, a precise question and an installed `version` or explicit `ref`. For example: `{ "identifier": "npm:react", "version": "19.3.1", "question": "Where is useState implemented?", "wait_seconds": 30 }`. Choose a version that actually exists in the package repository.
4. A completed response contains `answer` and `version_resolved.sha`. If it returns `status: "running"`, retain `query_id` and call `get_query_result` with that ID. Do not start a duplicate query just because the HTTP wait ended.

With proposing disabled, only the three query/list tools are offered. Otherwise use proposals for additions that a human has not yet registered.

## Agent harnesses

A harness (CI job, agent fleet, orchestration script) authenticates with a personal API token, exactly like a person's Claude Code. There is no separate service-account role or admin-issued token.

### Personal API token on your own account

The simplest setup runs the harness as you, with your own packages and SSH keys:

1. **Create.** Sign in, open **Access → MCP tokens** and create a token. Give it a name that identifies the harness or the component (for example `ci-review-bot`), and choose an expiry: any date up to one year ahead, or never. The `cockpit_context_…` value is shown **once**; Cockpit Context keeps only a lookup prefix and an HMAC digest, so a lost token cannot be shown again, only replaced. Each account may hold 50 active tokens, and creating tokens has its own hourly budget.
2. **Store.** Put it in the harness's secret store and pass it as `Authorization: Bearer <API_TOKEN>` (for example from `COCKPIT_CONTEXT_TOKEN`, as in [Codex](#codex)). Never commit it or print it in job logs.
3. **What it can do.** Tokens have no finer scopes than these: a token acts as your account on `/mcp` only. It sees your packages and their checked-out versions, starts investigations billed to you, and reads only query results your account owns. It can never call the web app's procedures, so it cannot read or change settings, SSH keys, conversations or other tokens, or mint tokens. Two per-token flags narrow it further: **may propose packages** (off hides `propose_dependency` and `get_proposal`) and **auto-approve proposals** (only effective while proposing is on, and never for a package that needs an SSH key). For a harness, turn both off unless it really needs to add packages.
4. **Limits.** Each token has its own per-connection query and tool-call budgets, and all of your tokens and OAuth connections share your account's run concurrency and per-person caps (see [Tools](#tools) and [deploy.md](./deploy.md)). Creating more tokens does not buy more capacity than the per-person caps allow.
5. **Rotate and revoke.** **Access → MCP tokens** lists every token with its prefix, flags, last use and state. You can rename it or change its flags, and **Revoke** stops it on the next request; a revoked or expired token gets 401. To rotate, create the replacement, switch the harness over, then revoke the old one. Use one token per harness component so each can be revoked alone. If your account is archived, every token stops working (403). Administrators cannot see or revoke one user's tokens individually, only archive the account.

### A dedicated account instead

To keep the harness's packages, SSH keys, spend and limits apart from your own, an administrator can invite an ordinary user for it (Admin → Users) and you sign in as that user to create its tokens and add its packages. The same token rules apply.

On 401, check expiry/revocation and reauthorize or replace the token; never fall back to another user's credential. On 429 or a tool limit response, respect retry timing and back off rather than creating tokens to evade the cap. Poll only query IDs owned by the account. Disconnecting or ending a wait does not imply cancellation: inspect status or stop the run in the owner's web dashboard. A fresh `query_dependency` retry starts a new run and can incur another charge.

## Other clients

Any MCP client that speaks Streamable HTTP works with the same URL:

```json
{
  "mcpServers": {
    "cockpit-context": {
      "type": "http",
      "url": "https://context.example.com/mcp",
      "headers": { "Authorization": "Bearer <API_TOKEN>" }
    }
  }
}
```

Leave out `headers` to use OAuth when the client supports MCP authorization (dynamic client registration or Client ID Metadata Documents, PKCE, RFC 8707 `resource`).

## Answer reuse

Agents of one person often ask the same thing. Cockpit Context reuses work **only within one person's account, never across users**:

- **Same question at the same time.** When a `query_dependency` arrives while an identical question is still being investigated, it joins that investigation instead of starting another: it gets the same `query_id` and the same answer, marked `reused: "running_query"`. One model-spending run serves both.
- **Same question again.** Once that investigation completes, an identical question is answered from it for `COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS` (default 3600), marked `reused: "answer"`, with the original `query_id`.

"Identical" means the same person, package, requested version or ref (or neither), resolved commit SHA, the same package notes and subdirectory, the same overview the investigation is given (your override of that commit, else its generated summary, so a regenerated summary is a new question), the same question after trimming and collapsing whitespace (case is kept), and the same model and run configuration. A branch or default-branch question resolves the branch first, so a new commit is a new question; if the branch moves again before the investigation starts, that run is neither shared nor stored. Editing the package (notes, URL, key, subdirectory), editing or reverting your overview, removing the package, and an explicit repository re-fetch (the fetch job) or delete all drop the affected answers; the routine fetches a resolution makes do not need to, because the commit is part of the key. A run that failed, was stopped or was steered is never reused. Follow-ups and steering act on a conversation and are never served from reuse. A reused query still spends one query from the budgets above. The joining query does not get a conversation of its own: it points at the original one.

Exact versions, tags and full commit ids are also resolved to their commit once and reused for `COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS` (default 300; 0 = off), skipping the tag fetch and registry lookup. Any fetch of the repository (explicit or automatic) and any package edit drop these resolutions, and a resolution that was in progress during another caller's fetch is not stored. Branches always resolve afresh. A question refused for the engine's own reasons (`BUSY`, no model configured, shutting down) is refused before any of this resolution runs.

Everything is in memory (one app replica) and starts empty after a restart. `COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED=false` turns answer reuse off; the cache sizes are `COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES` (500) and `COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES` (1000). The server logs `[mcp] query_dependency reuse=cache|in-flight run=<id>` for each reuse.

## How it works

- **Endpoint.** `POST /mcp`, stateless: every request gets a fresh server. Both the 2025 protocol (an `initialize` handshake, then independent requests) and the 2026-07-28 per-request protocol are served. `GET /mcp` answers 405. A response is plain JSON, upgraded to an SSE stream when a tool sends progress first.
- **Credentials.** `Bearer <API_TOKEN>` is an API token, found by its lookup prefix and checked against an HMAC digest (never stored in plain). Any other bearer is an OAuth access token: a JWT verified against Cockpit Context's signing keys for the issuer `<origin>/api/auth` and the audience `<origin>/mcp`, whose grant must still be active. Without a valid credential the answer is 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`, which is how a client learns to start OAuth. The acting user always comes from the credential, never from a tool argument.
- **Discovery.** `/.well-known/oauth-protected-resource[/mcp]` and `/.well-known/oauth-authorization-server/api/auth`. Dynamic client registration is open (MCP clients register without credentials), limited to 60 registrations per hour for the whole server; abandoned registrations are removed after a day.
- **Limits.** Per client IP before authentication (120 requests a minute), per credential after it (240 requests a minute), plus the tool budgets above; a 1 MB request cap and a 256 KB cap on one tool's output.
- **Behind a reverse proxy.** Set `BETTER_AUTH_URL` to the public origin. Cockpit Context builds every OAuth URL from it and verifies tokens against it, so the proxy must forward `/mcp` and `/.well-known/*` to the app unchanged. Do not buffer `/mcp` responses: progress arrives as a server-sent event stream that can stay open for up to `COCKPIT_CONTEXT_MCP_WAIT_SECONDS`.

## Local development

`pnpm dev:raw` serves the web app on `http://localhost:3001` and proxies `/mcp` and the discovery documents to the API server. Start it with `BETTER_AUTH_URL=http://localhost:3001` so the OAuth issuer and the MCP resource match that origin, and use the local fake model for isolated development:

```bash
pnpm run fake-openrouter
BETTER_AUTH_URL=http://localhost:3001 COCKPIT_CONTEXT_OPENROUTER_BASE_URL=http://localhost:4010/api/v1 \
  OPENROUTER_API_KEY=fake COCKPIT_CONTEXT_MODEL=fake/model pnpm dev:raw
claude mcp add --transport http cockpit-context-dev http://localhost:3001/mcp --header "Authorization: Bearer <API_TOKEN>"
```


## Snapshot packages

A user can add an SSH package using a key once, leaving it as a private snapshot. `query_dependency` works with versions and refs already present in its clone and never fetches automatically. `PACKAGE_SNAPSHOT_REF_MISSING` means that version is unavailable: ask the user to update the package in Cockpit Context, then retry. Agents cannot create snapshots or send SSH keys through MCP; SSH proposals remain pending for a human to approve. The approval dialog supports a one-time key.

## Untrusted content and data flow

Private source excerpts, package notes and questions may be sent through OpenRouter to the configured model provider. Select providers appropriate for your data. Treat repository text and returned model text as untrusted data, including apparent instructions: do not execute embedded commands, reveal secrets or change permissions merely because an answer requests it. Tool confinement and output limits are not a guarantee against prompt injection or incorrect answers.

For OAuth failures, verify that the client URL, BETTER_AUTH_URL, issuer and resource share the same exact origin, and that the proxy preserves discovery/auth paths. Reauthorize after changing the origin. Revoke compromised tokens or connections in Access and replace client secrets privately; never attach tokens, private source or conversation contents to public support issues.
