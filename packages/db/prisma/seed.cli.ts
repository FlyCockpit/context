// Standalone CLI entry for `prisma db seed` (wired via `migrations.seed` in
// prisma.config.ts — Prisma 7 ignores the legacy package.json `prisma.seed`
// key once that config file exists). Keeps seed.ts free of side effects on import so the
// inline admin path (`seed.run`) can `import { runSeed }` without executing it. This wrapper owns process lifecycle: run, print the
// summary, disconnect the shared client, exit with the right code.
//
//   pnpm db:seed                               # demo data for the first admin
//   pnpm db:seed -- --email you@example.com    # … for that user
//
// Load repo-root `.env` before `@cockpit-context/db` → `@cockpit-context/env/shared` so this
// entry works under `tsx` as well as via `prisma db seed` (which also loads
// `.env` in prisma.config.ts for the parent process).
import "@cockpit-context/env/load-dotenv";

import { parseArgs } from "node:util";

import prisma from "../src/index";
import { runSeed } from "./seed";

const { values } = parseArgs({
  options: { email: { type: "string" } },
  // `prisma db seed -- <args>` forwards everything after `--`.
  strict: false,
});
const ownerEmail = typeof values.email === "string" ? values.email : undefined;

runSeed({ ownerEmail })
  .then((result) => {
    if (result.summary.length === 0) {
      console.log("[seed] Done — seed script is empty (nothing to seed).");
    } else {
      console.log("[seed] Done:");
      for (const line of result.summary) console.log(`  • ${line}`);
    }
  })
  .catch((error) => {
    console.error("[seed] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
