/**
 * Start one investigation through the real run engine against the fake
 * OpenRouter, and print what it saved (docs/development.md).
 *
 *   pnpm run fake-openrouter                      # terminal 1
 *   COCKPIT_CONTEXT_OPENROUTER_BASE_URL=http://localhost:4010/api/v1 OPENROUTER_API_KEY=fake COCKPIT_CONTEXT_MODEL=fake/model \
 *     pnpm run demo:run -- --steer "focus on the tests" "How do I escape a string for a RegExp?"
 *
 * Flags:
 *   --email <address>      whose package (default: the first admin, else the first user)
 *   --package <identifier> default npm:escape-string-regexp (seeded by `pnpm db:seed`)
 *   --version <v> | --ref <ref>
 *   --steer <text>         steer the run `--steer-after-ms` (default 2500) after it starts
 *   --stop-after-ms <n>    stop the run after n ms instead of waiting for it
 *   --follow-up <text>     send a follow-up once the first run finishes
 *   --conversation <id>    instead of a new conversation, send the question as a
 *                          follow-up in this finished one (e.g. a seeded one)
 *
 * Development only: it refuses NODE_ENV=production, and it refuses a
 * COCKPIT_CONTEXT_OPENROUTER_BASE_URL that is not on localhost, so it can never spend
 * money on a real model. The run executes in this process (the dev server's
 * engine does not see it live); its rows, and the summary job it enqueues,
 * are shared through Postgres.
 */

import { parseArgs } from "node:util";

import prisma from "../packages/db/src/index.ts";
import { getRunEngine, type RunSnapshot } from "../packages/runs/src/index.ts";

const { values, positionals } = parseArgs({
  // `pnpm run <script> -- --flag` forwards the `--` itself; drop it.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  allowPositionals: true,
  options: {
    email: { type: "string" },
    package: { type: "string", default: "npm:escape-string-regexp" },
    version: { type: "string" },
    ref: { type: "string" },
    steer: { type: "string" },
    "steer-after-ms": { type: "string", default: "2500" },
    "stop-after-ms": { type: "string" },
    "follow-up": { type: "string" },
    conversation: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`[demo-run] ${message}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") fail("refusing to run with NODE_ENV=production.");
const baseUrl = process.env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL;
let baseHost = "";
try {
  baseHost = baseUrl ? new URL(baseUrl).hostname : "";
} catch {
  // Reported below.
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(baseHost)) {
  fail(
    "COCKPIT_CONTEXT_OPENROUTER_BASE_URL must point at the local fake OpenRouter (http://localhost:<port>/api/v1). This script never calls a real model.",
  );
}

const question = positionals.join(" ").trim() || "How do I escape a string for use in a RegExp?";

const found = values.email
  ? await prisma.user.findUnique({
      where: { email: values.email },
      select: { id: true, email: true },
    })
  : ((await prisma.user.findFirst({
      where: { role: { contains: "admin" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true },
    })) ??
    (await prisma.user.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true },
    })));
const owner = found ?? fail("no such user. Sign up in the app first (or pass --email).");

const engine = getRunEngine();
const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

async function begin(): Promise<{ conversationId: string; runId: string }> {
  if (values.conversation) {
    console.log(`[demo-run] ${owner.email} follows up in ${values.conversation}: ${question}`);
    return engine.sendMessage({
      ownerId: owner.id,
      conversationId: values.conversation,
      text: question,
    });
  }
  const pkg = await prisma.package.findUnique({
    where: { ownerId_identifier: { ownerId: owner.id, identifier: values.package } },
    select: { id: true, identifier: true },
  });
  if (!pkg) fail(`${owner.email} has no package ${values.package}. Run \`pnpm db:seed\` first.`);
  console.log(`[demo-run] ${owner.email} asks about ${pkg.identifier}: ${question}`);
  const started = await engine.startConversation({
    ownerId: owner.id,
    packageId: pkg.id,
    text: question,
    version: values.version ?? null,
    ref: values.ref ?? null,
    origin: "web",
  });
  console.log(`[demo-run] at ${started.commitSha.slice(0, 12)} (${started.resolvedFrom})`);
  return started;
}

const conversation = await begin();
console.log(`[demo-run] conversation ${conversation.conversationId} run ${conversation.runId}`);

const unsubscribe = engine.bus.subscribe(conversation.conversationId, (event) => {
  if (event.type === "delta" || event.type === "run.progress") return;
  const who = event.runId === conversation.runId ? "main" : `helper ${event.runId.slice(-6)}`;
  const detail =
    event.type === "turn"
      ? `${event.turn.role}${event.turn.steering ? " (steering)" : ""} #${event.turn.seq}`
      : event.type === "run.phase"
        ? event.phase
        : event.type === "run.finished"
          ? `${event.status}${event.stopReason ? ` (${event.stopReason})` : ""}`
          : event.type === "helper.started"
            ? `focus ${event.focus}`
            : "";
  console.log(`[demo-run] ${elapsed()} ${who} ${event.type} ${detail}`);
});

if (values.steer) {
  const steerText = values.steer;
  setTimeout(() => {
    engine
      .steer({ ownerId: owner.id, conversationId: conversation.conversationId, text: steerText })
      .then((result) => console.log(`[demo-run] ${elapsed()} steered (turn #${result.seq})`))
      .catch((error: unknown) => console.warn("[demo-run] steer refused:", error));
  }, Number(values["steer-after-ms"]));
}
if (values["stop-after-ms"]) {
  setTimeout(() => {
    void engine
      .stop({ ownerId: owner.id, conversationId: conversation.conversationId })
      .then((stopped) => console.log(`[demo-run] ${elapsed()} stop requested: ${stopped}`));
  }, Number(values["stop-after-ms"]));
}

const report = (snapshot: RunSnapshot) =>
  console.log(
    `[demo-run] ${elapsed()} run ${snapshot.runId}: ${snapshot.status}${snapshot.stopReason ? ` (${snapshot.stopReason})` : ""}, ${snapshot.iterations} iterations, $${(snapshot.usage.costUsdMicros / 1e6).toFixed(6)}`,
  );

let snapshot = await engine.waitForRun({
  ownerId: owner.id,
  runId: conversation.runId,
  timeoutMs: 10 * 60_000,
});
report(snapshot);

if (values["follow-up"] && snapshot.status !== "running" && snapshot.status !== "queued") {
  const next = await engine.sendMessage({
    ownerId: owner.id,
    conversationId: conversation.conversationId,
    text: values["follow-up"],
  });
  snapshot = await engine.waitForRun({
    ownerId: owner.id,
    runId: next.runId,
    timeoutMs: 10 * 60_000,
  });
  report(snapshot);
}
unsubscribe();

// pagination:audited — one conversation's runs; the demo makes a handful.
const runs = await prisma.agentRun.findMany({
  where: { conversationId: conversation.conversationId, ownerId: owner.id },
  orderBy: { createdAt: "asc" },
  select: {
    id: true,
    kind: true,
    status: true,
    focus: true,
    _count: { select: { Turns: true } },
    Turns: { where: { steering: true }, select: { seq: true } },
  },
});
for (const run of runs) {
  console.log(
    `[demo-run] saved ${run.kind} ${run.id}: ${run.status}, ${run._count.Turns} turns${run.Turns.length > 0 ? `, steering at #${run.Turns.map((turn) => turn.seq).join(", #")}` : ""}${run.focus ? ` — focus ${run.focus}` : ""}`,
  );
}
console.log("--- answer ---");
console.log(snapshot.answer ?? "(none)");

await engine.shutdown(5_000);
await prisma.$disconnect();
process.exit(snapshot.status === "completed" ? 0 : 2);
