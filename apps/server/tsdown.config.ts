import { defineConfig } from "tsdown";

export default defineConfig({
  // Object form so the emitted file stays `dist/index.mjs` (referenced by
  // `pnpm start`, both Dockerfile CMDs, and scripts/docker-entrypoint.sh) while
  // the actual entry is the bootstrap wrapper that guarantees the root `.env` is
  // loaded before any env validation runs. See src/bootstrap.ts.
  // `lsp-sandbox-check` is the language-server sandbox's hostile-checkout
  // check, run by hand in a live container (src/lsp-sandbox-check.ts).
  entry: { index: "./src/bootstrap.ts", "lsp-sandbox-check": "./src/lsp-sandbox-check.ts" },
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    // Bundle dotenv with the entrypoint helper (`@cockpit-context/env/load-dotenv`) so
    // production images do not need a resolvable `dotenv` package for the
    // server process. Validation modules never import dotenv; only the
    // entrypoint load path does.
    //
    // `dotenv` is deliberately NOT a dependency of this app — it resolves
    // transitively through `@cockpit-context/env`, which is the only workspace package
    // that declares it. Keep it there: adding it back here would let a direct
    // `import "dotenv"` compile in server code, which is exactly what
    // `pnpm env:check-entrypoints` exists to prevent.
    // The MCP plugin and our OAuth-state reader must share one provider
    // instance. Externalizing only MCP gives it a second request-state key,
    // so production authorization cannot derive its consent reference.
    alwaysBundle: [/@cockpit-context\/.*/, "dotenv", "@better-auth/mcp"],
    // (The TanStack Start SSR handler at apps/web/dist/server is imported via
    // a runtime-computed specifier in src/index.ts, so rolldown leaves it
    // external automatically — no entry needed here.)
  },
});
