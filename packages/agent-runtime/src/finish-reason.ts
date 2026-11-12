/**
 * Provider finish-reason normalization.
 *
 * Every provider spells "the model stopped because it hit the output token ceiling"
 * differently — OpenAI/OpenRouter chat completions say `length`, Anthropic direct says
 * `max_tokens`, Gemini says `MAX_TOKENS`, and the OpenAI Responses API reports it out of
 * band as `incomplete_details.reason = "max_output_tokens"`. Treating that case as a
 * clean stop is silent data loss: a long tool-call argument array cut off mid-stream
 * yields a malformed/dropped tool call, and the caller would otherwise mark the run
 * successful with none of the work it described actually done.
 *
 * The loop therefore never compares raw finish-reason strings; it normalizes here.
 */

/** The only finish-reason values the loop reasons about. Exhaustive by construction. */
export type NormalizedFinishReason =
  | "tool-calls"
  | "stop"
  | "length"
  | "content-filter"
  | "error"
  | "unknown";

/** Lowercase and strip separators so `MAX_TOKENS`, `max-tokens`, `maxTokens` all collapse. */
const canonical = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Spelling → normalized value. Keyed on {@link canonical} output, so every case/
 * separator variant of a spelling maps through a single entry.
 */
const FINISH_REASON_ALIASES: Record<string, NormalizedFinishReason> = {
  // Tool/function calling requested — the only value that continues the loop.
  toolcalls: "tool-calls",
  toolcall: "tool-calls",
  tooluse: "tool-calls",
  functioncall: "tool-calls",
  functioncalls: "tool-calls",
  // Output ceiling hit — truncated, never a clean finish.
  length: "length",
  maxtokens: "length",
  maxoutputtokens: "length",
  maxcompletiontokens: "length",
  modellength: "length",
  tokenlimit: "length",
  outputtokenlimit: "length",
  truncated: "length",
  // Natural end of turn.
  stop: "stop",
  endturn: "stop",
  stopsequence: "stop",
  end: "stop",
  complete: "stop",
  completed: "stop",
  eos: "stop",
  // Provider-side content refusal/blocking.
  contentfilter: "content-filter",
  safety: "content-filter",
  recitation: "content-filter",
  prohibitedcontent: "content-filter",
  blocklist: "content-filter",
  refusal: "content-filter",
  // Provider signalled a failed generation in the finish reason itself.
  error: "error",
};

/** Normalize a raw provider finish reason. Unrecognized/absent values are `"unknown"`. */
export const normalizeFinishReason = (raw: string | null | undefined): NormalizedFinishReason => {
  if (typeof raw !== "string") return "unknown";
  const key = canonical(raw);
  if (key.length === 0) return "unknown";
  return FINISH_REASON_ALIASES[key] ?? "unknown";
};

/** Raw fields a `RUN_FINISHED`-shaped chunk may carry a finish reason in. */
const FINISH_REASON_FIELDS = [
  "finishReason",
  "finish_reason",
  // OpenRouter passes the upstream provider's own spelling through untouched here,
  // which is where a Gemini `MAX_TOKENS` survives after the SDK mapped the OpenAI-shaped
  // field to `stop`.
  "nativeFinishReason",
  "native_finish_reason",
  // Anthropic direct / some OpenAI-compatible shims.
  "stopReason",
  "stop_reason",
  // OpenAI Responses API surfaces truncation only as an incomplete reason.
  "incompleteReason",
  "incomplete_reason",
] as const;

/** Every finish-reason-ish string present on a chunk, in field-priority order. */
export const collectFinishReasons = (chunk: unknown): string[] => {
  if (typeof chunk !== "object" || chunk === null) return [];
  const record = chunk as Record<string, unknown>;
  const found: string[] = [];
  for (const field of FINISH_REASON_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) found.push(value);
  }
  const details = record.incomplete_details ?? record.incompleteDetails;
  if (typeof details === "object" && details !== null) {
    const reason = (details as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) found.push(reason);
  }
  return found;
};

/**
 * True when *any* finish-reason field on the chunk means "output was cut off".
 *
 * Deliberately an OR across fields, not a decision on the primary field alone: when a
 * provider reports `tool_calls` while its native reason says the response was truncated,
 * the tool-call arguments are the thing that got cut off. Stopping and reporting
 * truncation is always safer than continuing on a half-parsed call.
 */
export const isTruncatedFinish = (chunk: unknown): boolean =>
  collectFinishReasons(chunk).some((raw) => normalizeFinishReason(raw) === "length");
