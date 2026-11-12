# Contributing to Cockpit Context

Please open an issue to discuss larger changes before starting. Everyone participating is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](./SECURITY.md).

## License

Cockpit Context is MIT licensed (see [LICENSE](./LICENSE)). By submitting a contribution you agree to license it under the same MIT terms. There is no separate contributor agreement or DCO sign-off requirement. Preserve third-party attribution and include notices for any newly distributed material.

## Setup and checks

Use Node.js 26.13.1 and the pinned pnpm 12 installer. Follow [development setup](./docs/development.md) and [AGENTS.md](./AGENTS.md). Use disposable development credentials and local services. Unit tests mock database and import-time IO; never point tests at a real shared database.

Keep changes focused and explain the problem, resulting behavior and checks run. Run `pnpm verify:fast` before handing back a change; full `pnpm verify` runs in CI/release. If a required check cannot run, say why and provide the relevant output with secrets/private content removed. Do not bypass hooks or weaken checks.

Read [product boundaries](./docs/product.md) and the [access matrix](./docs/access-matrix.md) before changing permissions, procedures or models. Schema changes include reviewed [migrations and fixtures](./docs/schema-changes-recipe.md); merged migration files are immutable. UI strings use `t()`. New env vars require schema plus manifest and `pnpm env:sync`. Public page changes update discovery paths and sitemap. Edit AGENTS directly and regenerate mirrors with `pnpm sync:agent-docs`.

## Issues and pull requests

Include reproduction steps, expected behavior and version/commit for bugs. For features explain the problem, alternatives and access/privacy implications. Use the PR checklist and link related issues. Do not include private dependency source, prompts/answers, SSH keys, API tokens, filled env files or personal data in public reports.
