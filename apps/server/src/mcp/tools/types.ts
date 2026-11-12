import type { z } from "zod";

import type { McpIdentity } from "../credentials";

/** What a tool body gets for one call. */
export interface McpToolContext {
  /** Who the call acts as: from the credential, never from tool input. */
  identity: McpIdentity;
  /** Aborted when the client disconnects or the server shuts down. */
  signal: AbortSignal;
  requestId: string;
  /** Best-effort progress notification to the client (never throws). */
  progress(message: string): Promise<void>;
}

/**
 * A refusal the agent can act on. `message` is fixed server text written for
 * the coding agent (never git stderr, paths or provider messages); `details`
 * carries allowlisted structured hints such as close matches or nearby tags.
 */
export class McpToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

export interface McpToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Schema;
  /** Listed and callable only when the connection may propose packages. */
  requiresPropose?: boolean;
  /** Also spends the per-credential query budget (a model-spending run). */
  spendsQuery?: boolean;
  run(input: z.output<Schema>, ctx: McpToolContext): Promise<unknown>;
}

/** Erases the schema type so definitions of different tools share one list. */
export function defineTool<Schema extends z.ZodType>(
  definition: McpToolDefinition<Schema>,
): McpToolDefinition {
  return definition as unknown as McpToolDefinition;
}
