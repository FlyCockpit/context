import { type AgentTool, defineTool, wrapUntrustedContent } from "@cockpit-context/agent-runtime";
import { z } from "zod";

import { exploreGlobAsync, exploreRead, MAX_GREP_MATCHES } from "./fs-ops";
import { resolveWithinRoot } from "./paths";
import { exploreGrep, type RipgrepSetting } from "./ripgrep";

/** Inline result budget for each confined tool (the runtime's default). */
const EXPLORE_TOOL_MAX_RESULT_CHARS = 32_000;

const UNTRUSTED_TRUNCATION_NOTE =
  "\n[truncated: result exceeded the tool output budget; narrow the query or page with offset]";

/**
 * Fence a tool result as untrusted checkout content, kept within `maxChars`.
 *
 * Everything a confined tool returns — file bodies, match lines, and the paths
 * themselves (a file name is attacker-writable too) — comes from the dependency
 * under investigation, so the whole serialized result goes inside the fence.
 * The body is clipped *before* wrapping so the result never exceeds the tool's
 * `maxResultChars`: an oversized body would otherwise be cut by the runtime
 * after the end marker was written, or stored and re-wrapped a second time.
 */
export function wrapUntrustedToolResult(
  value: unknown,
  sourceLabel: string,
  maxChars = EXPLORE_TOOL_MAX_RESULT_CHARS,
): string {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const overhead = wrapUntrustedContent("", { sourceUrl: sourceLabel }).length;
  const budget = Math.max(0, maxChars - overhead);
  const fitted =
    body.length <= budget
      ? body
      : `${body.slice(0, Math.max(0, budget - UNTRUSTED_TRUNCATION_NOTE.length))}${UNTRUSTED_TRUNCATION_NOTE}`;
  return wrapUntrustedContent(fitted, { sourceUrl: sourceLabel });
}

const ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: "Not found",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EACCES: "Permission denied",
  ELOOP: "Too many symbolic links",
};

/**
 * Run a tool body so its error never carries a host path back to the model.
 *
 * Node's fs errors embed the absolute path (`ENOENT: …, stat '/srv/…/x'`),
 * which would reveal the server's checkout layout; they are reported against
 * the path the model asked for instead. Any other message has the real root
 * replaced as a backstop.
 */
async function withoutHostPaths<T>(
  rootReal: string,
  requested: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      throw new Error(`${ERRNO_MESSAGES[code] ?? code}: ${requested}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(rootReal).join("."));
  }
}

export type ExploreToolsOptions = {
  /** grep backend; defaults to `"auto"` (ripgrep from PATH, else JavaScript). */
  ripgrep?: RipgrepSetting;
};

/**
 * Read-only codebase investigation tools, confined to `root`.
 *
 * All three are `untrusted: true` and fence their output with
 * `wrapUntrustedContent`, so the system prompt must carry
 * `UNTRUSTED_CONTENT_SYSTEM_RULES` (`buildExploreSystemPrompt` derives that from
 * the tool list).
 */
export function buildExploreTools(root: string, options: ExploreToolsOptions = {}): AgentTool[] {
  // Fail fast if the configured root is missing / not a directory.
  const rootReal = resolveWithinRoot(root, ".");

  const grepTool = defineTool({
    name: "grep",
    description:
      "Regex content search under the explore root. Use to find a function, type, export, or usage example. Prefer narrowing with path when you already know the subtree.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("JavaScript RegExp source (not /delimited/)"),
      path: z
        .string()
        .optional()
        .describe("Optional subdirectory or file relative to the explore root"),
      case_insensitive: z.boolean().optional().describe("Defaults to false"),
      max_matches: z.number().int().min(1).max(MAX_GREP_MATCHES).optional(),
    }),
    maxResultChars: EXPLORE_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: ({ pattern, path: searchPath, case_insensitive, max_matches }, signal) =>
      withoutHostPaths(rootReal, searchPath ?? ".", async () =>
        wrapUntrustedToolResult(
          await exploreGrep(root, pattern, {
            searchPath,
            caseInsensitive: case_insensitive,
            maxMatches: max_matches,
            ripgrep: options.ripgrep,
            signal,
          }),
          `checkout:grep:${searchPath ?? "."}`,
        ),
      ),
  });

  const globTool = defineTool({
    name: "glob",
    description:
      "List files matching a glob under the explore root (e.g. `**/*.{ts,tsx}`, `examples/**`, `**/README*`). Use to locate the public API surface or examples before reading.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Glob pattern relative to path / explore root"),
      path: z.string().optional().describe("Optional subdirectory relative to the explore root"),
    }),
    maxResultChars: EXPLORE_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: ({ pattern, path: searchPath }, signal) =>
      withoutHostPaths(rootReal, searchPath ?? ".", async () =>
        wrapUntrustedToolResult(
          await exploreGlobAsync(root, pattern, searchPath ?? ".", { signal }),
          `checkout:glob:${searchPath ?? "."}`,
        ),
      ),
  });

  const readTool = defineTool({
    name: "read",
    description:
      "Read a specific text file once you have narrowed it down. Lines are returned as `N|content` with 1-based numbering. Use offset/limit to page large files.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File path relative to the explore root"),
      offset: z.number().int().min(1).optional().describe("1-based start line (default 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .describe("Max lines to return (default 200, max 400)"),
    }),
    maxResultChars: EXPLORE_TOOL_MAX_RESULT_CHARS,
    untrusted: true,
    execute: ({ path: relativePath, offset, limit }) =>
      withoutHostPaths(rootReal, relativePath, () =>
        wrapUntrustedToolResult(
          exploreRead(root, relativePath, { offset, limit }),
          `checkout:read:${relativePath}`,
        ),
      ),
  });

  return [globTool, grepTool, readTool];
}
