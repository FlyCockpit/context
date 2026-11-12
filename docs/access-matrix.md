# Users, roles and access matrix

Read this before changing any procedure, route gate or schema field. The table headings and procedure cells are consumed by `scripts/check-access-matrix.ts`; update them in the same change as the procedure.

## Roles

| Role | Who |
|---|---|
| Anonymous | Not signed in; can view public pages and available authentication flows. |
| User | Owns packages, proposals, SSH keys, known hosts, MCP credentials and conversations. |
| Admin | User rights over their own data, plus user management, instance settings, jobs, backup status and repository storage management. |

Admins cannot read another user's packages, conversations, summary overrides, keys or tokens. They cannot impersonate users, set another user's password or email directly, or list their sessions. Invites provide a one-time set-password link, never a password. The one password path is `users.passwordLink`: an admin can issue a one-time set-password link for a non-admin account that signs in with a password. With SMTP it goes only to the user's mailbox (a failed send revokes it); without SMTP the admin sees it once, so on such a server an admin could use it to set that user's password. Every link is audited, and admin accounts never receive one (demote first, itself a visible action). Storage administrators can see repository URLs, sizes, last use and private owners, and delete caches. The host/database operator necessarily has infrastructure access; these are application permissions.

## Ownership rules

Queries scope packages, proposals, credentials, conversations, runs and turns to the acting user. Foreign IDs return NOT_FOUND. MCP identity comes from its credential, never a tool argument. API tokens authorize MCP tools only, never browser procedures or admin functions.

Public HTTPS repository clones, checkouts and generated overviews can be shared through each user's own packages. Private SSH repositories are owner-isolated even when URLs match. A user's edited overview is private. MCP proposal and auto-approval flags further restrict each credential; human account, credential and SSH management remain web actions.

## Access matrix

`implemented` rows describe shipped surfaces. New endpoints remain `planned` until their bindings exist. A dash in Enforcing procedure denotes a non-oRPC surface, documented separately in [MCP](./mcp.md).

| Feature | Status | Anonymous | User | Admin | Enforcing procedure | Notes |
|---|---|---|---|---|---|---|
| View the public landing page | implemented | read | read | read | — |  |
| Manage their own account (email, password, sessions, 2FA) | implemented | none | own | full | — |  |
| Read public app config (signup open?, email configured?, operator identity, conversation retention) | implemented | read | read | read | `appConfig` | Public configuration only; no secret values. |
| Read own home status (getting-started progress, pending-proposal badge, live-run count, MCP URL) | implemented | none | own | own | `home.status` |  |
| List own packages | implemented | none | own | own | `packages.list` |  |
| View one own package with its checkouts | implemented | none | own | own | `packages.get` |  |
| Create a package | implemented | none | own | own | `packages.create` |  |
| Edit a package (name, git URL, subdirectory, tag pattern, notes) | implemented | none | own | own | `packages.update` |  |
| Update an own snapshot with a pasted SSH key (optionally save it) | implemented | none | own | own | `packages.updateSnapshot` | One-time credentials remain request-local unless explicitly saved. |
| Delete a package | implemented | none | own | own | `packages.delete` |  |
| Look up a git URL from the package registry | implemented | none | yes | yes | `packages.lookupRegistry` |  |
| List own pending and decided proposals | implemented | none | own | own | `proposals.list` |  |
| Approve a proposal (creates the package) | implemented | none | own | own | `proposals.approve` |  |
| Reject a proposal | implemented | none | own | own | `proposals.reject` |  |
| List checkouts behind own packages | implemented | none | own | own | `repositories.listCheckouts` |  |
| Fetch the latest default branch for an own package's repository | implemented | none | own | own | `repositories.refresh` |  |
| Delete a checkout behind an own package | implemented | none | own | own | `repositories.deleteCheckout` | Shared public cache; administrators use adminStorage.delete for any repository. |
| Edit their own version of a checkout's overview summary | implemented | none | own | own | `repositories.updateSummary` | The caller's private override; generated public overview remains shared. |
| Revert their own overview edit to the model-written one | implemented | none | own | own | `repositories.revertSummary` |  |
| Regenerate a checkout's overview summary | implemented | none | own | own | `repositories.regenerateSummary` | Replaces the shared generated overview, preserving private overrides. |
| List own SSH keys | implemented | none | own | own | `sshKeys.list` |  |
| Generate an SSH key | implemented | none | own | own | `sshKeys.generate` |  |
| Import an SSH private key | implemented | none | own | own | `sshKeys.import` | Saved private keys are encrypted and never returned. |
| Delete an SSH key | implemented | none | own | own | `sshKeys.delete` |  |
| List own confirmed known hosts | implemented | none | own | own | `knownHosts.list` |  |
| Scan a host's SSH fingerprint for confirmation | implemented | none | yes | yes | `knownHosts.scan` |  |
| Confirm a known host | implemented | none | own | own | `knownHosts.confirm` |  |
| Remove a known host | implemented | none | own | own | `knownHosts.delete` |  |
| View the built-in (pinned) host keys | implemented | none | read | read | `knownHosts.pinned` |  |
| List own MCP API tokens | implemented | none | own | own | `mcpTokens.list` |  |
| Create an MCP API token | implemented | none | own | own | `mcpTokens.create` | Plaintext shown once; only a digest is stored. |
| Change an MCP token's flags (propose, auto-approve) | implemented | none | own | own | `mcpTokens.update` |  |
| Revoke an MCP API token | implemented | none | own | own | `mcpTokens.revoke` |  |
| List own OAuth MCP connections | implemented | none | own | own | `mcpConnections.list` |  |
| Change an OAuth connection's flags | implemented | none | own | own | `mcpConnections.update` |  |
| Revoke an OAuth MCP connection | implemented | none | own | own | `mcpConnections.revoke` |  |
| List own conversations (ongoing first) | implemented | none | own | own | `conversations.list` |  |
| View a conversation with its runs and turns | implemented | none | own | own | `conversations.get` |  |
| Watch a run live | implemented | none | own | own | `conversations.watch` |  |
| Watch own conversations' activity (live lists) | implemented | none | own | own | `conversations.activity` |  |
| Start a web conversation about an own package | implemented | none | own | own | `conversations.create` |  |
| Send a follow-up message in a finished conversation | implemented | none | own | own | `conversations.send` |  |
| Steer a running run | implemented | none | own | own | `conversations.steer` |  |
| Stop a running run | implemented | none | own | own | `conversations.stop` |  |
| Delete a conversation | implemented | none | own | own | `conversations.delete` |  |
| Read the conversation retention period | implemented | none | read | read | `conversations.retention` |  |
| Automatic deletion of inactive conversations | implemented | none | none | none | — |  |
| List own dependencies over MCP | implemented | none | own | own | — |  |
| Ask a dependency question over MCP | implemented | none | own | own | — |  |
| Propose a package over MCP | implemented | none | own | own | — |  |
| Approve an MCP OAuth connection (consent page) | implemented | none | own | own | — |  |
| Register an MCP OAuth client (dynamic registration) | implemented | yes | yes | yes | — |  |
| Admin dashboard and user management | implemented | none | none | full | `users.list` | Administrative user management; no impersonation or credential access. |
| Send a user a one-time set-password link | implemented | none | none | full | `users.passwordLink` | Single use, bound to the user, 7-day expiry, supersedes earlier links; refused for admins (demote first), archived and SSO-only accounts; audited. With SMTP it is emailed only to the user, and a failed send revokes it and returns an error, never the link; without SMTP the admin receives it once to pass on. |
| Sign in as another user, set their password or email directly, list their sessions | implemented | none | none | none | — |  |
| Change site settings (signup toggle) | implemented | none | none | full | `settings.update` |  |
| View the effective server configuration (COCKPIT_CONTEXT_* limits, model names, OpenRouter/SMTP/backups configured, conversation retention, operator identity, LSP tools and their sandbox: mechanism, Landlock ABI, active protections) | implemented | none | none | full | `settings.runtimeConfig` | Effective configuration; secret presence is reported as booleans. |
| View backup freshness on the admin dashboard | implemented | none | none | full | `adminBackups.status` | Off-site freshness monitoring, independent of backup scheduling. |
| View storage across all repositories | implemented | none | none | full | `adminStorage.list` |  |
| Delete any clone or checkout | implemented | none | none | full | `adminStorage.delete` |  |
| Run storage pruning now | implemented | none | none | full | `adminStorage.prune` |  |
| View background jobs | implemented | none | none | full | `adminJobs.list` |  |
| Retry a failed background job | implemented | none | none | full | `adminJobs.retry` |  |

## Sensitive boundaries

Saved SSH private keys are encrypted using `COCKPIT_CONTEXT_ENCRYPTION_KEYS` and never returned. One-time snapshot keys are request-local unless explicitly saved. Verify SSH fingerprints independently. Archiving an account revokes its sessions and MCP credentials and stops all of its runs (main and overview summary, queued or running); unarchiving does not restore them. `users.passwordLink` is the one admin path to a user's password, and only for non-admin password accounts: with SMTP the link goes only to the user's mailbox (a failed send revokes it), but without SMTP the admin holds a link that would set the user's password, so every link writes an `[audit]` log line and the privacy notice says so. MCP credentials do not require an interactive second factor per request.

Dependency content and model output are untrusted. Read tools are confined; required Landlock failure disables language-server tools. Runs have time, iteration, concurrency and rate budgets. Summary runs share the global cap but are exempt from the user main-run cap. See [product limits](./product.md#limits) and [deployment](./deploy.md).
