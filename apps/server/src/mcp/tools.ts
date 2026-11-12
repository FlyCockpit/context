import { cockpitContextRateBudget } from "@cockpit-context/api/lib/rate-budgets";
import { env } from "@cockpit-context/env/server";
import type {
  CallToolResult,
  McpRequestContext,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { z } from "zod";

import { credentialKey, type McpIdentity } from "./credentials";
import { errorClass, mcpSanitizedLog } from "./errors";
import { redactSecrets } from "./redaction";
import { toJsonSafe } from "./serialization";
import { type McpToolDispatch, resolveMcpToolDispatch } from "./tool-dispatch";
import { listDependenciesTool } from "./tools/dependencies";
import { getProposalTool, proposeDependencyTool } from "./tools/proposals";
import { createQueryTools } from "./tools/query";
import { type McpToolContext, type McpToolDefinition, McpToolError } from "./tools/types";

/**
 * Cockpit Context's MCP tools (docs/mcp.md) and the wrapper chain every
 * call runs through, adapted from ws-model-proxy's `mcp/tools.ts`:
 *
 *   1. dispatch: the verified request's identity (`tool-dispatch.ts`); none →
 *      fail closed;
 *   2. flags: a propose tool on a connection that may not propose answers
 *      exactly like an unknown tool (and is not listed);
 *   3. rate limits per credential: tool calls per minute
 *      (`COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE`) and, for `query_dependency`,
 *      queries per hour (`COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR`), then queries per
 *      hour across all of one user's credentials
 *      (`COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR`, default 120, 0 = off);
 *      fail-closed. No role is exempt;
 *   4. input: the tool's zod schema; errors name the field, never the value;
 *   5. the tool body, with the request's abort signal and a progress sender;
 *   6. output: redact → JSON-safe → 256 KB cap.
 *
 * Tool arguments are never logged.
 */

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  listDependenciesTool,
  ...createQueryTools(),
  proposeDependencyTool,
  getProposalTool,
];

/** Hard cap on one tool's serialized output. */
const MCP_TOOL_OUTPUT_MAX_BYTES = 256 * 1024;
/** Headroom for the fields the SDK adds after the check. */
const OUTPUT_BUDGET_BYTES = MCP_TOOL_OUTPUT_MAX_BYTES - 1024;

function mcpToolAllowed(tool: McpToolDefinition, identity: McpIdentity): boolean {
  return !tool.requiresPropose || identity.allowPropose;
}

/**
 * A standard schema that advertises the tool's JSON Schema and accepts any
 * arguments: the chain validates with the zod schema itself, so the SDK
 * never echoes a validation message that could carry an argument.
 */
function advertisedSchema(tool: McpToolDefinition): StandardSchemaWithJSON {
  const json = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  const { $schema: _ignored, ...schema } = json;
  return {
    "~standard": {
      version: 1,
      vendor: "Cockpit Context",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

/**
 * Registers the tools this request's connection may call. Without a verified
 * dispatch the non-propose tools are listed and every call fails closed.
 */
export function registerMcpTools(server: McpServer, ctx?: McpRequestContext): void {
  const dispatch = resolveMcpToolDispatch(ctx?.authInfo);
  for (const tool of MCP_TOOLS) {
    if (tool.requiresPropose && !dispatch?.identity.allowPropose) continue;
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      tool.name,
      { description: tool.description, inputSchema: advertisedSchema(tool) },
      async (args: unknown, toolCtx: ServerContext): Promise<CallToolResult> =>
        runMcpTool(tool, { dispatch, args, progress: progressSender(toolCtx) }),
    );
  }
}

/**
 * `notifications/progress` when the client sent a progress token, otherwise
 * a log message. Never throws: progress is best effort.
 */
function progressSender(ctx: ServerContext): (message: string) => Promise<void> {
  const token = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message: string) => {
    progress += 1;
    try {
      if (token !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken: token, progress, message },
        });
      } else {
        await ctx.mcpReq.log("info", message, "cockpit-context");
      }
    } catch {
      // The client may have gone away; the tool's own wait notices.
    }
  };
}

// ── rate limits ──

let toolCallLimiter: RateLimiterMemory | undefined;
let queryLimiter: RateLimiterMemory | undefined;
/** null: COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR is 0 (unlimited). Default 120. */
let userQueryLimiter: RateLimiterMemory | null | undefined;

const USER_QUERY_WINDOW_SECONDS = 3_600;

function limiters() {
  if (!toolCallLimiter) {
    const budget = cockpitContextRateBudget("mcpToolCall"); // COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE
    toolCallLimiter = new RateLimiterMemory({
      keyPrefix: "mcp:tool-calls",
      points: budget.points,
      duration: budget.durationSeconds,
    });
  }
  if (!queryLimiter) {
    const budget = cockpitContextRateBudget("mcpQuery"); // COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR
    queryLimiter = new RateLimiterMemory({
      keyPrefix: "mcp:queries",
      points: budget.points,
      duration: budget.durationSeconds,
    });
  }
  if (userQueryLimiter === undefined) {
    // Not a Cockpit Context rate budget (those cannot be off): 0 turns it off.
    const points = env.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR;
    userQueryLimiter =
      points === undefined || points === 0
        ? null
        : new RateLimiterMemory({
            keyPrefix: "rl:mcp-query-user",
            points,
            duration: USER_QUERY_WINDOW_SECONDS,
          });
  }
  return { toolCallLimiter, queryLimiter, userQueryLimiter };
}

/** Test-only: forget every rate-limit counter. */
export function resetMcpToolRateLimitsForTests(): void {
  toolCallLimiter = undefined;
  queryLimiter = undefined;
  userQueryLimiter = undefined;
}

/** Seconds to wait when over budget, null when within it. Fail-closed on a limiter fault. */
async function consume(limiter: RateLimiterMemory, key: string): Promise<number | null> {
  try {
    await limiter.consume(key);
    return null;
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) return Math.ceil(rejection.msBeforeNext / 1000);
    console.error(`[mcp] rate limiter failed, failing closed (${errorClass(rejection)})`);
    return 60;
  }
}

/**
 * Gives back one point taken earlier in this call. Best effort: a limiter
 * fault leaves the point spent, which only ever errs toward refusing.
 */
async function refund(limiter: RateLimiterMemory, key: string): Promise<void> {
  try {
    await limiter.reward(key, 1);
  } catch (error) {
    console.error(`[mcp] rate limiter refund failed (${errorClass(error)})`);
  }
}

// ── results ──

function toolError(message: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

/** The SDK's own text for an unregistered tool: a hidden tool looks the same. */
function unknownToolError(name: string): CallToolResult {
  return toolError(`Tool ${name} not found`, { error: { code: "NOT_FOUND" } });
}

function validationError(error: z.ZodError): CallToolResult {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message.slice(0, 200),
  }));
  return toolError(`Invalid input: ${issues.map((issue) => issue.path).join(", ")}.`, {
    error: { code: "invalid_input", issues },
  });
}

/** Redact, make JSON-safe and cap. Null when over the cap. */
export function serializeResult(output: unknown): CallToolResult | null {
  const safe = toJsonSafe(redactSecrets(output));
  const text = JSON.stringify(safe, null, 2) ?? "null";
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    ...(safe !== null && typeof safe === "object" && !Array.isArray(safe)
      ? { structuredContent: safe as Record<string, unknown> }
      : {}),
  };
  return new TextEncoder().encode(JSON.stringify(result)).length > OUTPUT_BUDGET_BYTES
    ? null
    : result;
}

function errorResult(error: McpToolError): CallToolResult {
  const structured = toJsonSafe(
    redactSecrets({ error: { code: error.code, message: error.message, ...error.details } }),
  );
  return toolError(
    String(redactSecrets(error.message)),
    structured !== null && typeof structured === "object"
      ? (structured as Record<string, unknown>)
      : {},
  );
}

/** One call through the wrapper chain (see the module docblock). */
export async function runMcpTool(
  tool: McpToolDefinition,
  state: {
    dispatch: McpToolDispatch | undefined;
    args: unknown;
    progress?: (message: string) => Promise<void>;
  },
): Promise<CallToolResult> {
  const { dispatch } = state;
  if (dispatch === undefined) {
    mcpSanitizedLog("tool dispatch rejected: no verified context", { toolName: tool.name });
    return toolError("Internal error", { error: { code: "INTERNAL_ERROR" } });
  }
  const { identity, requestId } = dispatch;
  if (!mcpToolAllowed(tool, identity)) return unknownToolError(tool.name);

  const key = credentialKey(identity.credential);
  const budgets = limiters();
  const callsRetry = await consume(budgets.toolCallLimiter, key);
  if (callsRetry !== null) {
    return toolError("Too many tool calls from this connection; try again shortly.", {
      error: { code: "TOO_MANY_REQUESTS", retry_after_seconds: callsRetry },
    });
  }

  const parsed = tool.input.safeParse(state.args ?? {});
  if (!parsed.success) return validationError(parsed.error);

  if (tool.spendsQuery) {
    const queryRetry = await consume(budgets.queryLimiter, key);
    if (queryRetry !== null) {
      return toolError(
        `This connection reached its hourly query limit. Try again in ${Math.ceil(queryRetry / 60)} minutes.`,
        { error: { code: "QUERY_LIMIT", retry_after_seconds: queryRetry } },
      );
    }
    if (budgets.userQueryLimiter !== null) {
      const userRetry = await consume(budgets.userQueryLimiter, `user:${identity.userId}`);
      if (userRetry !== null) {
        // The query never runs, so it must not cost the connection a point:
        // retrying against the account cap would drain every credential.
        await refund(budgets.queryLimiter, key);
        return toolError(
          `This account reached its hourly query limit. Try again in ${Math.ceil(userRetry / 60)} minutes.`,
          { error: { code: "QUERY_LIMIT", retry_after_seconds: userRetry } },
        );
      }
    }
  }

  const ctx: McpToolContext = {
    identity,
    signal: dispatch.signal,
    requestId,
    progress: state.progress ?? (async () => {}),
  };
  try {
    const output = await tool.run(parsed.data, ctx);
    const result = serializeResult(output);
    if (result === null) {
      mcpSanitizedLog("tool output exceeded the size cap", { toolName: tool.name, requestId });
      return toolError("Tool output exceeded the maximum size.", {
        error: { code: "OUTPUT_TOO_LARGE", max_bytes: MCP_TOOL_OUTPUT_MAX_BYTES },
      });
    }
    return result;
  } catch (error) {
    if (error instanceof McpToolError) return errorResult(error);
    mcpSanitizedLog(`tool call failed (${errorClass(error)})`, {
      toolName: tool.name,
      requestId,
    });
    return toolError("Internal error", { error: { code: "INTERNAL_ERROR" }, requestId });
  }
}
