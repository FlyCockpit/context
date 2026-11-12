import prisma, { type Prisma } from "@cockpit-context/db";
import { env } from "@cockpit-context/env/server";
import { getRunEngine, partsFromJson, type RunEvent } from "@cockpit-context/runs";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { ACTIVE_RUN_STATUSES, ongoingWhere } from "../lib/conversation-activity";
import { reasonError, withDomainErrors } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import { lower } from "../lib/packages";
import {
  cursorPage,
  cursorPageInput,
  cursorTokenSchema,
  pageTake,
  withCursor,
} from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { cockpitContextRateBudget } from "../lib/rate-budgets";
import { entityId } from "../lib/schemas";

/**
 * Conversations with the investigation agent (docs/product.md). Only
 * their owner ever reads them — admins included (docs/access-matrix.md).
 * Every query is scoped by `ownerId = session.user.id`, and every engine
 * call passes that id so the engine scopes too; a foreign id is NOT_FOUND.
 */

/**
 * One point per run started from the web: a new conversation or a
 * follow-up. Each is a full explore-agent run (model spend), on top of the
 * engine's per-user concurrency cap. The default 60 per hour
 * (`COCKPIT_CONTEXT_RUNS_PER_HOUR`) is a question a minute;
 * fail-closed because each point spends.
 */
const consumeRunBudget = createProcedureBudget({
  keyPrefix: "rl:conversations-run",
  budget: () => cockpitContextRateBudget("conversationRun"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many questions. Try again in ${seconds}s.`,
  unavailableMessage: "Asking is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[conversations] run budget unavailable, failing closed:",
});

/**
 * One point per steering message: a saved turn the live run reads at its
 * next step. Only possible while the owner's own run is live, so the default
 * 120 per 10 minutes (`COCKPIT_CONTEXT_STEERS_PER_10_MINUTES`) is far above a person typing; fail-closed (unbounded writes).
 */
const consumeSteerBudget = createProcedureBudget({
  keyPrefix: "rl:conversations-steer",
  budget: () => cockpitContextRateBudget("conversationSteer"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many steering messages. Try again in ${seconds}s.`,
  unavailableMessage: "Steering is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[conversations] steer budget unavailable, failing closed:",
});

/**
 * Live streams (`watch` + `activity`, combined) one user may hold open at
 * once: `COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER`, read on every open. Each is a
 * long-lived HTTP response with a bus subscription behind it, and the `/rpc`
 * limiter counts only the request that opened it. One tab holds one
 * `activity` and at most one `watch`; the default 20 is a person with ten
 * tabs open. In-process, like every limiter here: one app replica
 * (docs/hosting.md).
 */
const liveStreams = new Map<string, number>();

/**
 * Takes one of the user's live-stream slots, or refuses with
 * `TOO_MANY_REQUESTS` (the web client retries with backoff, so a slot
 * freed by closing a tab is picked up). The returned release is idempotent;
 * call it in a `finally` that covers every exit, client abort included.
 */
function acquireLiveStream(userId: string): () => void {
  const open = liveStreams.get(userId) ?? 0;
  if (open >= env.COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "Too many live views are open. Close some tabs and try again.",
    });
  }
  liveStreams.set(userId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (liveStreams.get(userId) ?? 1) - 1;
    if (remaining > 0) liveStreams.set(userId, remaining);
    else liveStreams.delete(userId);
  };
}

/** A conversation is finished once none of its main runs is queued or running. */
const finishedWhere = {
  AgentRuns: { none: { kind: "MAIN", status: { in: ACTIVE_RUN_STATUSES } } },
} satisfies Prisma.ConversationWhereInput;
/** The same rule as {@link ongoingWhere}, counted per row so the item flag matches its segment. */
const activeMainRunCount = {
  _count: {
    select: { AgentRuns: { where: { kind: "MAIN", status: { in: ACTIVE_RUN_STATUSES } } } },
  },
} satisfies Prisma.ConversationSelect;

/** Runs and turns returned by `get` / the `watch` snapshot. */
const MAX_RUNS = 200;
const MAX_TURNS = 5_000;
const MAX_MESSAGE_LENGTH = 20_000;

const messageText = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

const runUsageSelect = {
  inputTokens: true,
  outputTokens: true,
  cachedInputTokens: true,
  costUsdMicros: true,
} satisfies Prisma.AgentRunSelect;

const latestMainRunArgs = {
  where: { kind: "MAIN" },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  take: 1,
  select: {
    id: true,
    status: true,
    iterations: true,
    startedAt: true,
    finishedAt: true,
    stopReason: true,
    ...runUsageSelect,
  },
} satisfies Prisma.Conversation$AgentRunsArgs;

const conversationSelect = {
  id: true,
  createdAt: true,
  title: true,
  packageId: true,
  packageIdentifier: true,
  requestedVersion: true,
  requestedRef: true,
  commitSha: true,
  resolvedFrom: true,
  checkoutId: true,
  origin: true,
  mcpConnectionLabel: true,
  lastActivityAt: true,
  AgentRuns: latestMainRunArgs,
  ...activeMainRunCount,
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;

function usageOf(row: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsdMicros: number;
}) {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    costUsdMicros: row.costUsdMicros,
  };
}

function serializeConversation(row: ConversationRow, totalCostUsdMicros: number) {
  const latest = row.AgentRuns[0] ?? null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    /** The question's first line (agent-written over MCP): plain text. */
    title: row.title,
    packageId: row.packageId,
    packageIdentifier: row.packageIdentifier,
    requestedVersion: row.requestedVersion,
    requestedRef: row.requestedRef,
    commitSha: row.commitSha,
    resolvedFrom: row.resolvedFrom,
    /** False once the checkout was pruned; a follow-up re-creates it first. */
    checkoutAvailable: row.checkoutId !== null,
    origin: lower(row.origin),
    mcpConnectionLabel: row.mcpConnectionLabel,
    lastActivityAt: row.lastActivityAt,
    /** Some main run is queued or running: the `ongoing` list segment's rule. */
    ongoing: row._count.AgentRuns > 0,
    totalCostUsdMicros,
    latestRun: latest
      ? {
          id: latest.id,
          status: lower(latest.status),
          stopReason: latest.stopReason,
          iterations: latest.iterations,
          startedAt: latest.startedAt,
          finishedAt: latest.finishedAt,
          usage: usageOf(latest),
        }
      : null,
  };
}

/** Sum of every run's cost per conversation (helpers included), one query per page. */
async function totalCosts(
  ownerId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const sums = await prisma.agentRun.groupBy({
    by: ["conversationId"],
    where: { ownerId, conversationId: { in: conversationIds } },
    _sum: { costUsdMicros: true },
  });
  return new Map(
    sums.flatMap((row) =>
      row.conversationId ? [[row.conversationId, row._sum.costUsdMicros ?? 0] as const] : [],
    ),
  );
}

const runSelect = {
  id: true,
  createdAt: true,
  parentRunId: true,
  kind: true,
  status: true,
  trigger: true,
  model: true,
  focus: true,
  stopReason: true,
  iterations: true,
  startedAt: true,
  finishedAt: true,
  answer: true,
  ...runUsageSelect,
} satisfies Prisma.AgentRunSelect;

const turnSelect = {
  runId: true,
  seq: true,
  role: true,
  parts: true,
  steering: true,
  createdAt: true,
} satisfies Prisma.RunTurnSelect;

/**
 * A conversation with its runs and their saved turns, owner-scoped at every
 * level. Bounded: at most {@link MAX_RUNS} runs and {@link MAX_TURNS} turns
 * (`truncated` says when a bound was hit).
 */
async function loadConversationDetail(ownerId: string, conversationId: string) {
  const conversation = await findOwnedOrThrow({
    find: (args) => prisma.conversation.findFirst(args),
    args: { where: { id: conversationId }, select: conversationSelect },
    owner: { field: "ownerId", id: ownerId },
    notFound: "Conversation not found.",
  });
  // Reserve space for live runs even if a long-lived main has many newer helpers.
  const liveIds = getRunEngine()
    .liveState(ownerId, conversation.id)
    .runs.slice()
    .sort((a, b) => Number(a.kind !== "main") - Number(b.kind !== "main"))
    .slice(0, MAX_RUNS)
    .map((run) => run.runId);
  const liveRuns =
    liveIds.length === 0
      ? []
      : await prisma.agentRun.findMany({
          where: { conversationId: conversation.id, ownerId, id: { in: liveIds } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: MAX_RUNS,
          select: runSelect,
        });
  const recentRuns =
    liveRuns.length >= MAX_RUNS
      ? []
      : await prisma.agentRun.findMany({
          where: {
            conversationId: conversation.id,
            ownerId,
            ...(liveRuns.length ? { id: { notIn: liveRuns.map((run) => run.id) } } : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: MAX_RUNS - liveRuns.length,
          select: runSelect,
        });
  const runs = [...liveRuns, ...recentRuns].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const turns =
    runs.length === 0
      ? []
      : await prisma.runTurn.findMany({
          where: { runId: { in: runs.map((run) => run.id) } },
          orderBy: [{ createdAt: "desc" }, { runId: "desc" }, { seq: "desc" }],
          take: MAX_TURNS,
          select: turnSelect,
        });
  const turnsByRun = new Map<string, ReturnType<typeof serializeTurn>[]>();
  for (const turn of turns) {
    const list = turnsByRun.get(turn.runId) ?? [];
    list.push(serializeTurn(turn));
    turnsByRun.set(turn.runId, list);
  }
  for (const list of turnsByRun.values()) list.sort((a, b) => a.seq - b.seq);
  const costs = (await totalCosts(ownerId, [conversation.id])).get(conversation.id) ?? 0;
  return {
    ...serializeConversation(conversation, costs),
    runs: runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt,
      parentRunId: run.parentRunId,
      kind: lower(run.kind),
      status: lower(run.status),
      trigger: lower(run.trigger),
      model: run.model,
      focus: run.focus,
      stopReason: run.stopReason,
      iterations: run.iterations,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      answer: run.answer,
      usage: usageOf(run),
      turns: turnsByRun.get(run.id) ?? [],
    })),
    truncated: runs.length === MAX_RUNS || turns.length === MAX_TURNS,
  };
}

function serializeTurn(turn: Prisma.RunTurnGetPayload<{ select: typeof turnSelect }>) {
  return {
    seq: turn.seq,
    role: lower(turn.role),
    parts: partsFromJson(turn.parts),
    steering: turn.steering,
    createdAt: turn.createdAt,
  };
}

function ownerOf(context: { session: { user: { id: string } } }) {
  return { field: "ownerId", id: context.session.user.id };
}

async function ownedConversation(context: { session: { user: { id: string } } }, id: string) {
  return findOwnedOrThrow({
    find: (args) => prisma.conversation.findFirst(args),
    args: { where: { id }, select: { id: true } },
    owner: ownerOf(context),
    notFound: "Conversation not found.",
  });
}

const segmentSchema = z.enum(["ongoing", "finished"]);

/** `run.finished` as a client sees it: no `error` text (docs/product.md). */
type ClientRunFinished = Omit<Extract<RunEvent, { type: "run.finished" }>, "error">;
type ClientRunEvent = Exclude<RunEvent, { type: "run.finished" }> | ClientRunFinished;

/**
 * Map a bus event to what `watch` sends. A run's `error` text can carry git
 * stderr, filesystem paths or provider messages, so it never leaves the
 * server (`get` leaves it out too); `stopReason` is the stable reason code.
 */
function toClientEvent(event: RunEvent): ClientRunEvent {
  if (event.type !== "run.finished") return event;
  const { error: _error, ...rest } = event;
  return rest;
}

export const conversationsRouter = {
  /**
   * The instance-wide retention period (COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS), for
   * the history page's "deleted N days after last activity" line. 0 means
   * conversations are kept until deleted. Global, not per-user.
   */
  retention: protectedProcedure.handler(() => ({
    days: env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS,
  })),

  /**
   * Ongoing conversations first, then finished ones, each newest activity
   * first. The page token is `next = { segment, cursor }`: pass both back
   * unchanged (a null cursor is the first page of that segment).
   * A conversation that finishes between two pages can show up in both
   * segments (the list is live; the UI dedupes by id).
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: cursorPageInput.shape.limit,
        segment: segmentSchema.default("ongoing"),
        cursor: cursorTokenSchema.nullish(),
        packageId: entityId.optional(),
        origin: z.enum(["mcp", "web"]).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const base: Prisma.ConversationWhereInput = {
        ownerId,
        ...(input.packageId ? { packageId: input.packageId } : {}),
        ...(input.origin ? { origin: input.origin === "mcp" ? "MCP" : "WEB" } : {}),
      };
      const fetchSegment = (
        segment: z.infer<typeof segmentSchema>,
        cursor: string | undefined,
        limit: number,
      ) =>
        prisma.conversation.findMany({
          where: withCursor(
            { AND: [base, segment === "ongoing" ? ongoingWhere : finishedWhere] },
            "lastActivityAt",
            cursor,
            "desc",
          ),
          orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
          take: pageTake(limit),
          select: conversationSelect,
        });

      const items: ConversationRow[] = [];
      let next: { segment: z.infer<typeof segmentSchema>; cursor: string | null } | null = null;
      const inputCursor = input.cursor ?? undefined;
      let finishedCursor = input.segment === "finished" ? inputCursor : undefined;
      let remaining = input.limit;

      if (input.segment === "ongoing") {
        const page = cursorPage(
          await fetchSegment("ongoing", inputCursor, input.limit),
          input.limit,
          "lastActivityAt",
        );
        items.push(...page.items);
        remaining -= page.items.length;
        if (page.nextCursor) next = { segment: "ongoing", cursor: page.nextCursor };
        finishedCursor = undefined;
      }

      if (next === null && remaining > 0) {
        const page = cursorPage(
          await fetchSegment("finished", finishedCursor, remaining),
          remaining,
          "lastActivityAt",
        );
        items.push(...page.items);
        if (page.nextCursor) next = { segment: "finished", cursor: page.nextCursor };
      } else if (next === null) {
        // The ongoing segment filled this page exactly: say whether any
        // finished conversation follows.
        const anyFinished = await prisma.conversation.findFirst({
          where: { AND: [base, finishedWhere] },
          select: { id: true },
        });
        if (anyFinished) next = { segment: "finished", cursor: null };
      }

      const costs = await totalCosts(
        ownerId,
        items.map((row) => row.id),
      );
      return {
        items: items.map((row) => serializeConversation(row, costs.get(row.id) ?? 0)),
        next,
      };
    }),

  get: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) =>
      loadConversationDetail(context.session.user.id, input.id),
    ),

  /**
   * Live view: a `snapshot` (saved runs and turns, plus the engine's
   * in-memory phase, usage and in-flight assistant text), then every bus
   * event for the conversation until the client disconnects. Ownership is
   * checked before subscribing; the subscription is opened before the
   * snapshot is read so nothing published in between is lost (a turn can
   * then arrive in both; the client dedupes by run id and `seq`).
   */
  watch: protectedProcedure.input(z.object({ id: entityId })).handler(async function* ({
    input,
    context,
    signal,
  }) {
    const ownerId = context.session.user.id;
    const conversation = await ownedConversation(context, input.id);
    const engine = getRunEngine();
    const release = acquireLiveStream(ownerId);
    try {
      const events = engine.bus.iterate(conversation.id, { signal });
      try {
        const detail = await loadConversationDetail(ownerId, conversation.id);
        yield {
          type: "snapshot" as const,
          conversation: detail,
          live: engine.liveState(ownerId, conversation.id),
        };
        for await (const event of events) yield toClientEvent(event);
      } finally {
        await events.return?.();
      }
    } finally {
      release();
    }
  }),

  /**
   * Live-list hints: `{ type: "ready" }` once subscribed, then one
   * `{ type: "activity", conversationId, runId, change }` per lifecycle or
   * progress event of the caller's own runs (never deltas or turns). The
   * topic is the session user's id, so nothing of another user's ever
   * arrives. The client re-reads `list` on these (and once on `ready`, to
   * cover anything that happened before it subscribed).
   */
  activity: protectedProcedure.handler(async function* ({ context, signal }) {
    const userId = context.session.user.id;
    const engine = getRunEngine();
    const release = acquireLiveStream(userId);
    try {
      const events = engine.activity.iterate(userId, { signal });
      try {
        yield { type: "ready" as const };
        for await (const event of events) yield { type: "activity" as const, ...event };
      } finally {
        await events.return?.();
      }
    } finally {
      release();
    }
  }),

  /** Start a web conversation about an own package (spends model tokens). */
  create: protectedProcedure
    .input(
      z
        .object({
          packageId: entityId,
          text: messageText,
          version: z.string().trim().min(1).max(100).optional(),
          ref: z.string().trim().min(1).max(250).optional(),
        })
        .refine((value) => !(value.version && value.ref), {
          message: "Give a version or a ref, not both",
          path: ["ref"],
        }),
    )
    .handler(async ({ input, context, signal }) => {
      const ownerId = context.session.user.id;
      await findOwnedOrThrow({
        find: (args) => prisma.package.findFirst(args),
        args: { where: { id: input.packageId }, select: { id: true } },
        owner: ownerOf(context),
        notFound: "Package not found.",
      });
      // Charged before resolution on purpose: resolving a version or ref
      // clones or fetches from the user-named remote (outbound work), so a
      // request that then fails (VERSION_NOT_FOUND, HOST_KEY_UNCONFIRMED)
      // still costs its point. Otherwise unresolvable versions would be a
      // free way to make the server fetch.
      await consumeRunBudget(`user:${ownerId}`);
      return withDomainErrors(() =>
        getRunEngine().startConversation({
          ownerId,
          packageId: input.packageId,
          text: input.text,
          version: input.version ?? null,
          ref: input.ref ?? null,
          origin: "web",
          signal,
        }),
      );
    }),

  /** Follow-up in a finished conversation. Never reaches the coding agent. */
  send: protectedProcedure
    .input(z.object({ id: entityId, text: messageText }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const conversation = await ownedConversation(context, input.id);
      await consumeRunBudget(`user:${ownerId}`);
      return withDomainErrors(() =>
        getRunEngine().sendMessage({ ownerId, conversationId: conversation.id, text: input.text }),
      );
    }),

  /** Steer the live main run (CONFLICT / RUN_FINISHED once it is past steering). */
  steer: protectedProcedure
    .input(z.object({ id: entityId, text: messageText }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const conversation = await ownedConversation(context, input.id);
      await consumeSteerBudget(`user:${ownerId}`);
      return withDomainErrors(() =>
        getRunEngine().steer({ ownerId, conversationId: conversation.id, text: input.text }),
      );
    }),

  stop: protectedProcedure.input(z.object({ id: entityId })).handler(async ({ input, context }) => {
    const ownerId = context.session.user.id;
    const conversation = await ownedConversation(context, input.id);
    const stopped = await withDomainErrors(() =>
      getRunEngine().stop({ ownerId, conversationId: conversation.id }),
    );
    return { stopped };
  }),

  /** Delete a conversation with its runs and turns. Refused while any run is live. */
  delete: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      const conversation = await ownedConversation(context, input.id);
      // One statement: a run that starts after a separate check could not
      // slip in between the check and the delete.
      const { count } = await prisma.conversation.deleteMany({
        where: {
          id: conversation.id,
          ownerId,
          AgentRuns: { none: { status: { in: ACTIVE_RUN_STATUSES } } },
        },
      });
      if (count === 0) {
        throw reasonError("CONFLICT", "RUN_ACTIVE", "Stop the running investigation first.");
      }
      return { ok: true as const };
    }),
};
