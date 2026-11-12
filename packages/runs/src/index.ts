/**
 * @cockpit-context/runs — the run engine (docs/product.md): conversations and
 * their agent runs, saved turns, the live event bus, concurrency caps,
 * steering, stop, follow-ups, restart recovery, checkout leases and the
 * checkout overview summaries.
 *
 * Callers (routers, the MCP server, job handlers) check nothing the engine
 * does not: every entry point takes the acting user's id and scopes by it.
 */

export {
  type AnswerReuse,
  answerModelIdentity,
  answerReuseKey,
  configureAnswerReuse,
  invalidateAnswersForOwner,
  invalidateAnswersForPackage,
  invalidateAnswersForRepository,
  requestedTarget,
} from "./answer-reuse";
export { loadRunConfig, type RunConfig } from "./config";
export {
  getLspStatus,
  getRunEngine,
  onSummaryFailure,
  type SummaryFailureListener,
} from "./default-engine";
export {
  costMicros,
  createRunEngine,
  type LiveConversationState,
  type RunEngine,
  type RunEngineDeps,
  type RunSnapshot,
  type StartConversationInput,
  type StartedConversation,
  type StartedRun,
  type SummaryFailure,
  type SummaryRequest,
  type SummaryStart,
} from "./engine";
export { isRunEngineError, RunEngineError, type RunEngineErrorCode } from "./errors";
export {
  type RunActivityBus,
  type RunActivityEvent,
  type RunEvent,
  type RunEventBus,
  type RunKind,
  type RunPhase,
  type RunStatus,
  type RunUsageView,
  runEvents,
  type TurnRole,
  type TurnView,
} from "./events";
export { historyFromTurns } from "./history";
export { type ConversationOrigin, partsFromJson, prismaRunStore, type RunStore } from "./store";
