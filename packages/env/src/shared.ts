import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { backupCommonConfigWarnings } from "./backup-config.js";
import { sharedVars } from "./vars/shared.js";

// ---------------------------------------------------------------------------
// Shared environment — validation only.
//
// This module validates ONLY the variables that the packages outside the
// server entrypoint read (@cockpit-context/db, @cockpit-context/mailer, @cockpit-context/i18n-translate, the
// backup-freshness check, the web SSR graph, standalone scripts). It is the
// import target for every module that must load without the server-only
// variables.
//
// The server's full surface lives in ./server.ts, which `extends` this module
// and adds the server-only variables (Better-Auth, CORS, SSO, rate limits,
// admin emails, the job runner, …). Importing `@cockpit-context/env/server` from one of
// those shared packages would force every consumer (a script, the SSR graph,
// a test) to set BETTER_AUTH_URL, BETTER_AUTH_SECRET, etc.
//
// The strict-boolean helper lives in ./vars/shared.ts.
//
// Do NOT load `.env` here. This file is imported by auth/db and by the web SSR
// graph; a dotenv side effect left `dotenv` as a Vite SSR runtime external and
// broke production containers. Process entrypoints load the root `.env` first,
// via `@cockpit-context/env/load-dotenv` or `loadRootDotenv()` — see that file for the
// full rule, and `pnpm env:check-entrypoints` for the gate that enforces it.
//
// The variable declarations themselves live in ./vars/shared.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// triggering validation. Declare new variables there, never inline in the
// `createEnv` call.
// ---------------------------------------------------------------------------

export {
  type BackupConfig,
  backupCommonConfigWarnings,
  backupMonitorConfigWarnings,
} from "./backup-config.js";

export const env = createEnv({
  server: sharedVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((value) => {
      // These are shared backup-location warnings only. Writer and freshness
      // credentials intentionally have different grants, so their validators
      // run at their respective consumers rather than making the app (which
      // only monitors) look misconfigured for lacking the dump key.
      for (const warning of backupCommonConfigWarnings(value)) {
        console.warn(`WARNING: ${warning}`);
      }
    }),
});
