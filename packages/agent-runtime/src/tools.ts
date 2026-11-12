import { z } from "zod";

import { storedResultId } from "./stored-id";
import type { AgentTool, ResultStore } from "./types";
import { wrapUntrustedContent } from "./untrusted";

const DEFAULT_MAX_RESULT_CHARS = 32_000;

/**
 * Max characters a single `retrieve_tool_result` call returns. Kept comfortably
 * below `DEFAULT_MAX_RESULT_CHARS` so a retrieved (and possibly re-wrapped) slice
 * never itself overflows the cap and gets re-stored — the agent pages the tail
 * with successive offsets.
 */
const RETRIEVE_WINDOW_CHARS = 16_000;

/** Inline truncation when the result store is missing or failed a write. */
export const DEGRADED_TRUNCATION_MARKER =
  "\n[truncated — full result NOT retrievable: result storage unavailable; re-run the tool if you need the remainder]";

export interface DefineToolOptions<TSchema extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  /**
   * Run the tool. The second argument is the run's abort signal — see
   * {@link AgentTool.execute}. Ignoring it is fine; forwarding it to `fetch`
   * (or any cancellable API) is better, because the loop stops waiting at the
   * deadline whether or not the tool does.
   */
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown> | unknown;
  maxResultChars?: number;
  /** Mark results as untrusted source material — see {@link AgentTool.untrusted}. */
  untrusted?: boolean;
}

export const defineTool = <TSchema extends z.ZodType>(
  options: DefineToolOptions<TSchema>,
): AgentTool<TSchema> => ({
  name: options.name,
  description: options.description,
  inputSchema: options.inputSchema,
  execute: options.execute,
  maxResultChars: options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  untrusted: options.untrusted,
});

const stringify = (value: unknown): string => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized ?? String(value);
};

export const serializeToolResult = (value: unknown, maxResultChars: number): string => {
  const result = stringify(value);
  if (result.length <= maxResultChars) return result;

  const marker = maxResultChars < 12 ? "[truncated]" : "\n[truncated]";
  return `${result.slice(0, Math.max(0, maxResultChars - marker.length))}${marker}`;
};

export type SerializeRecordsOptions = {
  /** Optional text prefix that always survives (records fill the remainder of the budget). */
  header?: string;
  /**
   * When true, drop overflowing records without appending a count marker — used for
   * store-backed heads where the store marker follows instead.
   */
  omitRemainderMarker?: boolean;
};

/**
 * Budgeted record serializer: append whole JSON-serialized records until the next
 * would exceed `maxChars`, then stop atomically (never a partial record). When some
 * records are omitted, appends `[showing N of M records — remainder omitted]` unless
 * `omitRemainderMarker` is set.
 */
export const serializeRecords = (
  records: readonly unknown[],
  maxChars: number,
  options?: SerializeRecordsOptions,
): string => {
  const header = options?.header ?? "";
  const total = records.length;

  if (total === 0) {
    const empty = `${header}[]`;
    return empty.length <= maxChars ? empty : empty.slice(0, maxChars);
  }

  const countMarker = (shown: number) =>
    `\n[showing ${shown} of ${total} records — remainder omitted]`;

  const included: unknown[] = [];
  for (const record of records) {
    const next = [...included, record];
    const partial = next.length < total;
    const marker = partial && !options?.omitRemainderMarker ? countMarker(next.length) : "";
    const candidate = `${header}${JSON.stringify(next)}${marker}`;
    if (candidate.length <= maxChars) {
      included.push(record);
      continue;
    }
    // This record does not fit as a whole — drop it (and everything after).
    break;
  }

  if (included.length === 0) {
    const marker = options?.omitRemainderMarker ? "" : countMarker(0);
    const body = `${header}[]${marker}`;
    if (body.length <= maxChars) return body;
    // Budget smaller than the marker itself → marker only (trimmed if needed).
    if (marker.length > 0) return marker.slice(0, maxChars);
    return "".slice(0, maxChars);
  }

  const partial = included.length < total;
  const marker = partial && !options?.omitRemainderMarker ? countMarker(included.length) : "";
  return `${header}${JSON.stringify(included)}${marker}`;
};

const degradedTruncate = (value: unknown, maxResultChars: number): string => {
  const marker = DEGRADED_TRUNCATION_MARKER;
  if (Array.isArray(value)) {
    const budget = Math.max(0, maxResultChars - marker.length);
    const head = serializeRecords(value, budget);
    const out = `${head}${marker}`;
    return out.length <= maxResultChars
      ? out
      : `${serializeRecords(value, Math.max(0, maxResultChars - marker.length))}${marker}`.slice(
          0,
          maxResultChars,
        );
  }
  const body = stringify(value);
  if (body.length + marker.length <= maxResultChars) {
    // Fits with marker only if we always attach marker for overflow; body alone already overflowed.
  }
  return `${body.slice(0, Math.max(0, maxResultChars - marker.length))}${marker}`;
};

/**
 * Serialize a tool result, offloading the full body to `store` when it overflows
 * `maxResultChars`. Returns a bounded head plus a `[stored result …]` marker the
 * agent can page with `retrieve_tool_result`. Falls back to explicit degraded
 * truncation when no store is present or a store write fails.
 *
 * Array values use whole-record truncation for the inline head so the model never
 * sees half-JSON records.
 */
export const serializeToolResultWithStore = async (
  value: unknown,
  maxResultChars: number,
  options: { store?: ResultStore; untrusted?: boolean },
): Promise<string> => {
  const body = stringify(value);
  if (body.length <= maxResultChars) {
    return body;
  }

  if (!options.store) {
    return degradedTruncate(value, maxResultChars);
  }

  const untrusted = options.untrusted ?? false;
  const id = storedResultId(body, untrusted);
  try {
    await options.store.put(id, { body, untrusted });
  } catch (error) {
    // Store down / write failure → degrade to inline truncation for this result.
    // Never fail the turn because the store is unavailable.
    console.warn("[result-store] put failed; falling back to inline truncation", error);
    return degradedTruncate(value, maxResultChars);
  }

  const marker = `\n[stored result id=${id} total=${body.length} untrusted=${untrusted}; retrieve with retrieve_tool_result]`;
  // Reserve room for the marker and (when untrusted) the wrapper so the returned
  // head still respects the cap.
  const wrapOverhead = untrusted
    ? wrapUntrustedContent("", { sourceUrl: `stored:${id}` }).length
    : 0;
  const headBudget = Math.max(0, maxResultChars - marker.length - wrapOverhead);

  let headRaw: string;
  if (Array.isArray(value)) {
    headRaw = serializeRecords(value, headBudget, { omitRemainderMarker: true });
  } else {
    headRaw = body.slice(0, headBudget);
  }

  const head = untrusted
    ? wrapUntrustedContent(headRaw.slice(0, headBudget), { sourceUrl: `stored:${id}` })
    : headRaw;
  return `${head}${marker}`;
};

const retrieveToolResultSchema = z.object({
  id: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(RETRIEVE_WINDOW_CHARS).optional(),
});

/**
 * Runtime-provided tool that pages a stored large tool result by id. Registered
 * automatically for any loop given a {@link ResultStore}. Untrusted slices are
 * re-wrapped with the untrusted-content markers before returning so a paged tail
 * can never bypass the prompt-injection defense.
 */
export const buildRetrieveToolResultTool = (store: ResultStore): AgentTool =>
  defineTool({
    name: "retrieve_tool_result",
    description:
      "Retrieve a bounded slice of a previously stored large tool result by its id " +
      "(from a `[stored result id=… ]` marker). Pass `offset` (default 0) and `limit` " +
      "to page through the body; the response reports the offset, total size, and " +
      "whether more remains.",
    inputSchema: retrieveToolResultSchema,
    execute: async ({ id, offset, limit }) => {
      const window = Math.min(limit ?? RETRIEVE_WINDOW_CHARS, RETRIEVE_WINDOW_CHARS);
      const result = await store.get(id, offset ?? 0, window);
      if (!result) return { error: "expired or unknown result id" };
      // Wrap the slice (not the body) so the untrusted markers can never be split
      // across a slice boundary.
      const content = result.untrusted
        ? wrapUntrustedContent(result.slice, { sourceUrl: `stored:${id}` })
        : result.slice;
      const tail = result.hasMore
        ? "; more available, retrieve with a larger offset"
        : "; end of body";
      return `${content}\n[slice id=${id} offset=${result.offset} returned=${result.slice.length} total=${result.total}${tail}]`;
    },
  });
