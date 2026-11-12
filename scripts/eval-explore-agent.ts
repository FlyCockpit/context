/**
 * Manual batch quality eval for `runExploreAgent` against local clones.
 *
 *   pnpm run explore:eval -- --cases ./my-cases.json [--out ./eval-out]
 *
 * MANUAL ONLY — every case calls a real model and spends money. Never wire it
 * into verify, CI or a test. Needs OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL (root
 * `.env` or shell); COCKPIT_CONTEXT_HELPER_MODEL, COCKPIT_CONTEXT_OPENROUTER_BASE_URL,
 * COCKPIT_CONTEXT_MAX_ITERATIONS and COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS are honored when set.
 *
 * `--cases` is a JSON array of
 *   { "id", "repo", "root" (absolute path to a checkout), "question",
 *     "expectHints": ["strings a good answer mentions"] }
 * Results go to `<out>/eval-results.jsonl` plus a readable `eval-summary.md`
 * (default `<tmp>/cockpit-context-explore-eval-<timestamp>`). Hint hits are a rough signal
 * for the human grader, not a pass/fail.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { runExploreAgent } from "../packages/explore/src/index.ts";

type EvalCase = {
  id: string;
  repo: string;
  root: string;
  question: string;
  /** Short notes for the human grader about what a good answer should mention. */
  expectHints: string[];
};

const { values } = parseArgs({
  options: { cases: { type: "string" }, out: { type: "string" } },
});
if (!values.cases) {
  console.error("Usage: pnpm run explore:eval -- --cases <cases.json> [--out <dir>]");
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.COCKPIT_CONTEXT_MODEL?.trim();
if (!apiKey || !model) {
  console.error("Set OPENROUTER_API_KEY and COCKPIT_CONTEXT_MODEL to run the explore-agent eval.");
  process.exit(1);
}

const positiveInt = (raw: string | undefined): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};
const maxIterations = positiveInt(process.env.COCKPIT_CONTEXT_MAX_ITERATIONS);
const timeoutSeconds = positiveInt(process.env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS);

const outDir = path.resolve(
  values.out ?? path.join(os.tmpdir(), `cockpit-context-explore-eval-${Date.now()}`),
);
fs.mkdirSync(outDir, { recursive: true });
const outJsonl = path.join(outDir, "eval-results.jsonl");
const outMd = path.join(outDir, "eval-summary.md");

const cases = JSON.parse(fs.readFileSync(path.resolve(values.cases), "utf8")) as EvalCase[];
fs.writeFileSync(outJsonl, "");
fs.writeFileSync(
  outMd,
  `# Explore-agent eval\n\nModel: \`${model}\`\nStarted: ${new Date().toISOString()}\n\n`,
);

console.log(`[eval] ${cases.length} cases · model=${model} · out=${outDir}`);

for (const evalCase of cases) {
  console.log(`\n[eval] >>> ${evalCase.id} (${evalCase.repo})`);
  console.log(`[eval] Q: ${evalCase.question}`);
  if (!fs.existsSync(evalCase.root)) {
    fs.appendFileSync(
      outJsonl,
      `${JSON.stringify({ ...evalCase, ok: false, error: `root missing: ${evalCase.root}` })}\n`,
    );
    fs.appendFileSync(outMd, `## ${evalCase.id}\n\n**ERROR:** root missing\n\n`);
    continue;
  }

  const started = Date.now();
  try {
    const result = await runExploreAgent({
      root: evalCase.root,
      question: evalCase.question,
      package: { identifier: evalCase.repo },
      apiKey,
      model,
      helperModel: process.env.COCKPIT_CONTEXT_HELPER_MODEL?.trim() || undefined,
      baseUrl: process.env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL?.trim() || undefined,
      maxIterations,
      timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    });
    const answer = result.answer;
    const elapsedMs = Date.now() - started;
    const toolCalls = result.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool-call"),
    ).length;
    const hintsHit = evalCase.expectHints.filter((hint) =>
      answer.toLowerCase().includes(hint.toLowerCase()),
    );
    const row = {
      id: evalCase.id,
      repo: evalCase.repo,
      question: evalCase.question,
      stopReason: result.stopReason,
      forcedFinal: result.forcedFinal,
      elapsedMs,
      toolCalls,
      helperRuns: result.helperRuns.length,
      hintsHit,
      hintsMissed: evalCase.expectHints.filter((hint) => !hintsHit.includes(hint)),
      answer,
      usage: result.usage,
    };
    fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`);
    fs.appendFileSync(
      outMd,
      [
        `## ${evalCase.id}`,
        "",
        `**Repo:** ${evalCase.repo}`,
        `**Question:** ${evalCase.question}`,
        `**stopReason:** \`${result.stopReason}\` · **${elapsedMs}ms** · **${toolCalls} tool-calls** · **${result.helperRuns.length} helpers** · **$${(result.usage.costUsd ?? 0).toFixed(4)}**`,
        `**hint hits:** ${hintsHit.length}/${evalCase.expectHints.length} (${hintsHit.join(", ") || "none"})`,
        "",
        "### Answer",
        "",
        answer || "_(empty)_",
        "",
        "---",
        "",
      ].join("\n"),
    );
    console.log(
      `[eval] <<< ${evalCase.id} stop=${result.stopReason} ${elapsedMs}ms tools=${toolCalls} hints=${hintsHit.length}/${evalCase.expectHints.length}`,
    );
    console.log(answer.slice(0, 400).replace(/\n/g, " "));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.appendFileSync(
      outJsonl,
      `${JSON.stringify({ id: evalCase.id, repo: evalCase.repo, ok: false, error: message })}\n`,
    );
    fs.appendFileSync(outMd, `## ${evalCase.id}\n\n**ERROR:** ${message}\n\n---\n\n`);
    console.error(`[eval] <<< ${evalCase.id} ERROR: ${message}`);
  }
}

console.log(`\n[eval] wrote ${outMd}`);
