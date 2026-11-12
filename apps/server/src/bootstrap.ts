/**
 * Bundled process entry. Exists purely to guarantee load-before-validate order
 * in the BUILT artifact; `src/index.ts` is still the entry for `tsx` dev runs.
 *
 * The problem it solves: `import "@cockpit-context/env/load-dotenv"` being the first
 * import of `index.ts` is correct under plain ESM — static imports evaluate in
 * order, so the loader runs before `@cockpit-context/db` pulls in `@cockpit-context/env/shared`.
 * It is NOT sufficient after bundling. tsdown/rolldown inlines the tiny
 * `load-dotenv` body into the entry chunk's *body* while hoisting
 * `@cockpit-context/env/shared` into a separate chunk that the entry imports
 * statically — and ESM evaluates every static import before any of the
 * importer's own statements. The result is `createEnv()` running, and throwing
 * on missing vars, before `loadRootDotenv()` is ever reached. A populated root
 * `.env` sitting next to the bundle is silently ignored.
 *
 * A dynamic `import()` is the fix: it defers evaluation of the entire rest of
 * the graph — including every statically-hoisted chunk it depends on — until
 * after this module's body has run. Do not convert it to a static import, and
 * do not add any other static import to this file; either one reintroduces the
 * bug in a form that looks correct in source. `pnpm env:check-entrypoints`
 * enforces exactly that shape.
 *
 * See docs/development.md § Change workflow
 */
import "@cockpit-context/env/load-dotenv";

await import("./index.js");
