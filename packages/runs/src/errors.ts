/**
 * Run engine failures the routers and the MCP server map to translated
 * messages (or MCP tool errors). Ownership misses are always `*_NOT_FOUND`,
 * never "forbidden" (docs/access-matrix.md).
 */
export type RunEngineErrorCode =
  /** The package does not exist or is not the caller's. */
  | "PACKAGE_NOT_FOUND"
  /** The conversation does not exist or is not the caller's. */
  | "CONVERSATION_NOT_FOUND"
  /** The checkout does not exist or none of the caller's packages points at its repository. */
  | "CHECKOUT_NOT_FOUND"
  /** The run does not exist or is not the caller's. */
  | "RUN_NOT_FOUND"
  /** Steer refused: the main run already finished or is in its final synthesis. */
  | "RUN_FINISHED"
  /** Follow-up refused: the conversation's main run is still queued or running (steer instead). */
  | "RUN_ACTIVE"
  /** OPENROUTER_API_KEY or COCKPIT_CONTEXT_MODEL is not set. */
  | "MODEL_NOT_CONFIGURED"
  /** The server is shutting down and accepts no new runs. */
  | "ENGINE_STOPPED"
  /** The owner already has COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER main runs waiting for a slot. */
  | "BUSY";

export class RunEngineError extends Error {
  readonly code: RunEngineErrorCode;

  constructor(code: RunEngineErrorCode, message: string) {
    super(message);
    this.name = "RunEngineError";
    this.code = code;
  }
}

export function isRunEngineError(error: unknown): error is RunEngineError {
  return error instanceof RunEngineError;
}
