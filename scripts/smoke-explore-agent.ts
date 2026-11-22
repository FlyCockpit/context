/**
 * Manual smoke: run the explore agent against the sample-pkg fixture.
 *
 *   pnpm run explore:smoke
 *   pnpm run explore:smoke "How do I shout a greeting?"
 *
 * MANUAL ONLY — it calls a real model and spends money. Never wire it into
 * verify, CI or a test. Needs OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL (from the root
 * `.env`, which the package script loads with `node --env-file-if-exists`, or
 * from the shell). COCKPIT_CONTEXT_MODEL_API (chat-completions, responses or messages),
 * COCKPIT_CONTEXT_HELPER_MODEL, COCKPIT_CONTEXT_OPENROUTER_BASE_URL (point it at the
 * fake OpenRouter server for a free run) and COCKPIT_CONTEXT_MAX_ITERATIONS /
 * COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS are honored when set (scripts/lib/explore-script-env.ts).
 * The usage line lists the generation ids, for checking the cost against
 * OpenRouter's `GET /api/v1/generation?id=`.
 *
 * No Postgres needed: it calls `runExploreAgent` directly on
 * packages/explore/fixtures/sample-pkg.
 */

import path from "node:path";

import { runExploreAgent } from "../packages/explore/src/index.ts";
import { readExploreScriptEnv } from "./lib/explore-script-env.ts";

const settings = readExploreScriptEnv(process.env);
if (!settings.ok) {
  console.error(`[smoke-explore] ${settings.error}`);
  process.exit(1);
}
const { apiKey, model, api, helperModel, baseUrl, maxIterations, timeoutSeconds } = settings.value;

const root = path.resolve(import.meta.dirname, "../packages/explore/fixtures/sample-pkg");
const question =
  process.argv.slice(2).join(" ").trim() ||
  "How do I use the greet function? Include the shout option.";

console.log(`[smoke-explore] root=${root}`);
console.log(`[smoke-explore] api=${api} model=${model}`);
console.log(`[smoke-explore] question=${question}`);

const result = await runExploreAgent({
  root,
  question,
  package: { identifier: "npm:sample-pkg", versionOrRef: "fixture" },
  userNotes: "sample-pkg fixture: tiny TypeScript greeting helper",
  apiKey,
  api,
  model,
  helperModel,
  baseUrl,
  maxIterations: maxIterations ?? 8,
  timeoutMs: (timeoutSeconds ?? 120) * 1000,
  onTurn: ({ seq, role }) => console.log(`[smoke-explore] turn ${seq} ${role}`),
});

console.log(
  `[smoke-explore] stopReason=${result.stopReason} forcedFinal=${result.forcedFinal} iterations=${result.iterations} helpers=${result.helperRuns.length}`,
);
console.log(`[smoke-explore] usage=${JSON.stringify(result.usage)}`);
console.log("--- answer ---");
console.log(result.answer || "(empty assistant text)");
process.exit(result.stopReason === "completed" ? 0 : 2);
