/**
 * Byte/line budgeting helpers for tool authors.
 *
 * {@link serializeToolResult} in `tools.ts` caps by *characters* from the head,
 * which is right for a JSON payload the model reads top-down. These helpers
 * exist for the other shape: byte-capped, line-oriented text output (a file
 * read, a build log, a grep result), where the head-only cap is wrong.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **Never split a code point.** Byte caps are applied on the UTF-8 buffer and
 *    walked back to a UTF-8 boundary, so decoding always yields whole code
 *    points. The previous implementation trimmed UTF-16 *code units*
 *    (`slice.slice(0, -1)`), which could strip half a surrogate pair and bake a
 *    U+FFFD into the model's view of the file.
 * 2. **Never destroy the marker beneath you.** The final byte cap keeps a head
 *    *and* a tail (3:2), so a continuation marker appended by a shaping layer
 *    underneath — a read's `[truncated, ask read with offset N …]`, a retrieve
 *    hash, a compiler's error summary — survives the cap instead of being
 *    replaced by a marker with less information.
 */

export const TOOL_RESULT_BYTE_CAP = 8 * 1024;
export const READ_LINE_CAP = 2000;
export const GREP_MATCH_CAP = 50;

/**
 * How much pre-truncation output a producer retains for the retrieve pattern
 * (the result-store offload in `tools.ts`). Bounded because it is held for the life of the
 * run, not because the content is uninteresting.
 */
export const RETAIN_BYTE_CAP = 256 * 1024;

export type TruncationMeta = {
  truncated: boolean;
  originalBytes?: number;
  originalLines?: number;
  marker?: string;
};

/** Walk `index` back to a UTF-8 lead byte (or 0). */
function floorCharBoundary(buf: Buffer, index: number): number {
  let i = Math.min(Math.max(index, 0), buf.length);
  while (i > 0 && ((buf[i] ?? 0) & 0xc0) === 0x80) i -= 1;
  return i;
}

/** Walk `index` forward to a UTF-8 lead byte (or the end). */
function ceilCharBoundary(buf: Buffer, index: number): number {
  let i = Math.min(Math.max(index, 0), buf.length);
  while (i < buf.length && ((buf[i] ?? 0) & 0xc0) === 0x80) i += 1;
  return i;
}

/**
 * Cap a tool-result payload to `byteCap` bytes keeping a head **and** a tail.
 *
 * The elided middle is replaced with a one-line `... [truncated N bytes] ...`
 * marker. Errors and non-zero exits surface at the tail of a build log, so a
 * head-only cap systematically deletes the only part that mattered.
 */
export function budgetToolResult(
  text: string,
  opts?: { byteCap?: number },
): { text: string; meta: TruncationMeta } {
  const cap = opts?.byteCap ?? TOOL_RESULT_BYTE_CAP;
  const buf = Buffer.from(text, "utf8");
  const bytes = buf.length;
  if (bytes <= cap) {
    return { text, meta: { truncated: false, originalBytes: bytes } };
  }

  // Reserve room for the marker, then split the remaining budget 3:2.
  const markerReserve = 48;
  const budget = Math.max(0, cap - markerReserve);
  const headBudget = Math.floor((budget * 3) / 5);
  const tailBudget = budget - headBudget;
  const headEnd = floorCharBoundary(buf, headBudget);
  const tailStart = ceilCharBoundary(buf, Math.max(headEnd, bytes - tailBudget));
  const elided = Math.max(0, tailStart - headEnd);

  let head = buf.subarray(0, headEnd).toString("utf8");
  if (head.length > 0 && !head.endsWith("\n")) head += "\n";
  const marker = `... [truncated ${elided} bytes] ...`;
  const tail = buf.subarray(tailStart).toString("utf8");

  return {
    text: `${head}${marker}\n${tail}`,
    meta: { truncated: true, originalBytes: bytes, marker },
  };
}

/** Build the read-continuation marker with a real next offset. */
export function truncationMarker(nextOffset: number): string {
  return `... [truncated, ask read with offset ${nextOffset} to see more]`;
}

export type ReadSlice = {
  /** `${n}|${line}` numbered body, whole lines only. */
  numbered: string;
  truncated: boolean;
  /** 1-indexed line to pass as the next `offset`. */
  nextOffset: number;
  totalLines: number;
  offsetExceeded: boolean;
};

/**
 * Core of the `read` tool's output formatting: 1-indexed `offset`, `limit` in
 * lines, `${n}|${line}` numbering, and a byte ceiling that drops **whole
 * lines** — a half line of source is worse than no line, because the model
 * cannot tell which it got.
 */
export function readSlice(
  text: string,
  offset = 1,
  limit = READ_LINE_CAP,
  outputByteCap = TOOL_RESULT_BYTE_CAP,
): ReadSlice {
  const start = Math.max(1, Math.floor(offset));
  const max = Math.max(1, Math.floor(limit));
  // Headroom for the prelude/marker the caller appends.
  const byteCap = Math.max(0, outputByteCap - 80);

  const lines = splitLines(text);
  let numbered = "";
  let numberedBytes = 0;
  let emitted = 0;
  let truncated = false;
  let stoppedForBytes = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (lineNo < start) continue;
    if (emitted >= max || stoppedForBytes) {
      truncated = true;
      continue;
    }
    const rendered = `${lineNo}|${lines[i]}\n`;
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    if (numberedBytes + renderedBytes > byteCap && emitted > 0) {
      stoppedForBytes = true;
      truncated = true;
      continue;
    }
    numbered += rendered;
    numberedBytes += renderedBytes;
    emitted += 1;
  }

  const totalLines = lines.length;
  const offsetExceeded = start > totalLines;
  return {
    numbered,
    truncated,
    nextOffset: offsetExceeded ? totalLines + 1 : start + emitted,
    totalLines,
    offsetExceeded,
  };
}

/**
 * Split into lines the way `str::lines()` does: a trailing newline does not
 * mint an extra empty line, so "N lines" means what a text editor shows.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailing.split("\n");
}

/**
 * Cap grep-style match lists.
 */
export function budgetGrepMatches<T>(
  matches: readonly T[],
  opts?: { cap?: number },
): { matches: T[]; truncated: boolean; total: number } {
  const cap = opts?.cap ?? GREP_MATCH_CAP;
  if (matches.length <= cap) {
    return { matches: [...matches], truncated: false, total: matches.length };
  }
  return {
    matches: matches.slice(0, cap),
    truncated: true,
    total: matches.length,
  };
}
