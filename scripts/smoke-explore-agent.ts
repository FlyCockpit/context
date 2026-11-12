/**
 * Manual smoke: run the explore agent against the sample-pkg fixture.
 *
 *   pnpm run explore:smoke
 *   pnpm run explore:smoke "How do I shout a greeting?"
 *
 * MANUAL ONLY — it calls a real model and spends money. Never wire it into
 * verify, CI or a test. Needs OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL (from the root
 * `.env`, which the package script loads with `node --env-file-if-exists`, or
 * from the shell). COCKPIT_CONTEXT_HELPER_MODEL, COCKPIT_CONTEXT_OPENROUTER_BASE_URL (point it at the
 * fake OpenRouter server for a free run) and COCKPIT_CONTEXT_MAX_ITERATIONS /
 * COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS are honored when set.
 *
 * No Postgres needed: it calls `runExploreAgent` directly on
 * packages/explore/fixtures/sample-pkg.
 */

import path from "node:path";

import { runExploreAgent } from "../packages/explore/src/index.ts";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.COCKPIT_CONTEXT_MODEL?.trim();
if (!apiKey || !model) {
  console.error("Set OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL to run the explore-agent smoke.");
  process.exit(1);
}

const positiveInt = (raw: string | undefined): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const root = path.resolve(import.meta.dirname, "../packages/explore/fixtures/sample-pkg");
const question =
  process.argv.slice(2).join(" ").trim() ||
  "How do I use the greet function? Include the shout option.";
const timeoutSeconds = positiveInt(process.env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS);

console.log(`[smoke-explore] root=${root}`);
console.log(`[smoke-explore] model=${model}`);
console.log(`[smoke-explore] question=${question}`);

const result = await runExploreAgent({
  root,
  question,
  package: { identifier: "npm:sample-pkg", versionOrRef: "fixture" },
  userNotes: "sample-pkg fixture: tiny TypeScript greeting helper",
  apiKey,
  model,
  helperModel: process.env.COCKPIT_CONTEXT_HELPER_MODEL?.trim() || undefined,
  baseUrl: process.env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL?.trim() || undefined,
  maxIterations: positiveInt(process.env.COCKPIT_CONTEXT_MAX_ITERATIONS) ?? 8,
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
