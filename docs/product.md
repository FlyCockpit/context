# Product model

Cockpit Context is a self-hosted MCP service for answering dependency questions from real source at an exact package version or Git ref. A web dashboard manages packages and access, and lets people watch, steer, stop and continue investigations.

An organization can run one instance for its developers. An agent harness can run many sandboxed clients against one instance. Each developer or harness account still has its own package list and credentials. Shared repository storage reduces repeated cloning; it does not create a shared package catalog. Answers are reused only within one account ([mcp.md](./mcp.md#answer-reuse)).

## Entities

| Entity | Purpose |
|---|---|
| User | A user or administrator account. |
| Package | An owner-scoped dependency identifier, source URL, ref, optional subdirectory/tag pattern and notes. |
| Proposal | An MCP client's request to add a package, approved by the owner or permitted auto-approval. |
| Repository | A bare clone; shared for public HTTPS, owner-scoped for private SSH. |
| Checkout | A detached source tree at a resolved commit, with a repo map and generated overview. |
| SSH key / known host | Encrypted saved credentials and confirmed host fingerprints. |
| MCP credential | A per-user API token or OAuth grant with proposal controls. |
| Conversation / run / turn | An owner-only investigation thread, bounded execution and saved messages/tool results. |
| Job | Background work in PostgreSQL, executed within the app process. |

## Sharing and privacy

Users do not share packages, notes, proposals, conversations, credentials, private repositories or edited overview summaries. Public clones, checkouts, repo maps and generated overviews can be reused. Regenerating a public checkout's generated overview changes the shared generated version, while each user's override stays private. Completed question answers are never cached or reused across users; within one account an identical MCP question at the same commit, notes, overview and model configuration reuses the running or completed investigation ([mcp.md](./mcp.md#answer-reuse)).

Administrators manage users, settings and storage. They can see repository storage metadata (including private URLs and owners) and remove cached repositories; they have no application permission to read other users' conversations or keys. Host and database operators control the underlying infrastructure. See the [access matrix](./access-matrix.md).

Private repositories use SSH. A saved key supports refreshes; a one-time key creates a snapshot that cannot automatically fetch new refs. Private repositories are never reused across owners, including identical URLs. HTTPS credential tokens and GitHub App access are not supported private-repository mechanisms. Git hosts on private networks are refused unless the operator lists them in `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST` ([deploy § Internal git hosts](./deploy.md#internal-git-hosts)).

## Investigations and untrusted content

Version/ref resolution selects a checkout and records the resolved SHA. An unresolvable version is an error rather than a silent fallback to the default branch. Investigation tools search/read source and optionally query TypeScript/JavaScript and Python language servers. Questions, package notes, source excerpts and generated output may be sent to OpenRouter and the selected model provider; choose providers appropriate for private code.

Repository files can contain prompt injection. File tools label content untrusted and enforce checkout boundaries; language servers disable dependency installation and workspace code execution and use Landlock confinement by default. These controls reduce exposure, but do not guarantee that every model answer is safe or correct. Treat source and returned answers as data: do not follow instructions embedded in them to reveal secrets, change access controls or execute unrelated commands. Review cited source and commands before acting.

Main runs can be steered; helper runs can be watched. Web follow-ups remain in the web conversation and do not notify the original coding agent. An MCP retry that starts a new query creates another investigation and can incur another model charge.

## Limits

- There are user and admin roles, with no organization workspaces, shared package catalogs, per-package token scopes or first-class machine/service-account role. Invite a dedicated ordinary user for a harness and provision its packages and SSH access.
- Tokens act as their owning user. Separate tokens allow separate revocation and per-credential budgets, but share user concurrency and any aggregate user cap. Tokens may be created without expiry; choose an expiry when appropriate.
- Completed answers are reused only within one account and only for identical MCP questions (in memory, `COCKPIT_CONTEXT_ANSWER_CACHE_*`). Public clones/checkouts/overviews are reused across users; other questions start runs.
- One app replica is required. Concurrency, rate limiters and event delivery are process-local. Summary runs count globally but bypass main-run per-user concurrency; strict distributed fairness and per-user storage quotas are not provided.
- Administrators do not have a per-user spend dashboard or an individual-token override for other users. Archiving a user revokes all that user's credentials.
- Go/Rust language servers, dependency execution, embeddings/RAG search, billing and conversation sharing are not shipped.
- Cache pruning is instance-wide. One-time-key snapshot clones may not be reproducible after loss: protect them separately from database dumps.

See [configuration](./deploy.md#configuration) for effective limits, retention and model settings.
