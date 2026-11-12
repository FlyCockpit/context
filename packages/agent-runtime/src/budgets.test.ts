import { describe, expect, it } from "vitest";

import {
  budgetGrepMatches,
  budgetToolResult,
  READ_LINE_CAP,
  readSlice,
  splitLines,
  TOOL_RESULT_BYTE_CAP,
  truncationMarker,
} from "./budgets";

describe("budgetToolResult", () => {
  it("passes short results", () => {
    const r = budgetToolResult("hello");
    expect(r.meta.truncated).toBe(false);
    expect(r.text).toBe("hello");
  });

  it("keeps a head and a tail so trailing signal survives the cap", () => {
    const big = `${"x".repeat(TOOL_RESULT_BYTE_CAP * 2)}\nFAILED (exit 1)`;
    const r = budgetToolResult(big);
    expect(r.meta.truncated).toBe(true);
    expect(r.text).toContain("... [truncated");
    expect(r.text).toContain("FAILED (exit 1)");
  });

  it("preserves a continuation marker appended by a layer beneath it", () => {
    const marker = truncationMarker(2001);
    const body = `${"line\n".repeat(4000)}${marker}\n`;
    const r = budgetToolResult(body);
    expect(r.text).toContain(marker);
  });

  it("never splits a surrogate pair at the byte boundary", () => {
    // Emoji are 4 UTF-8 bytes / 2 UTF-16 code units — the exact shape the old
    // code-unit trim corrupted.
    const emoji = "😀";
    const r = budgetToolResult(emoji.repeat(TOOL_RESULT_BYTE_CAP));
    expect(r.meta.truncated).toBe(true);
    expect(r.text).not.toContain("�");
    for (const ch of r.text) {
      const code = ch.codePointAt(0) as number;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it("stays within the byte cap it was given", () => {
    const r = budgetToolResult("y".repeat(TOOL_RESULT_BYTE_CAP * 3));
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_BYTE_CAP);
  });
});

describe("readSlice", () => {
  it("numbers lines 1-indexed in the n|line format", () => {
    const slice = readSlice("a\nb\nc", 1, 10);
    expect(slice.numbered).toBe("1|a\n2|b\n3|c\n");
    expect(slice.truncated).toBe(false);
    expect(slice.totalLines).toBe(3);
  });

  it("honours a 1-indexed offset and reports the next offset", () => {
    const slice = readSlice("a\nb\nc\nd", 2, 2);
    expect(slice.numbered).toBe("2|b\n3|c\n");
    expect(slice.truncated).toBe(true);
    expect(slice.nextOffset).toBe(4);
  });

  it("flags an offset past EOF instead of returning an empty body", () => {
    const slice = readSlice("a\nb", 9, 10);
    expect(slice.offsetExceeded).toBe(true);
    expect(slice.totalLines).toBe(2);
    expect(slice.nextOffset).toBe(3);
  });

  it("drops whole lines at the byte cap, never a partial line", () => {
    const long = `${"z".repeat(500)}\n`;
    const slice = readSlice(long.repeat(100), 1, READ_LINE_CAP, 4096);
    expect(slice.truncated).toBe(true);
    for (const line of slice.numbered.split("\n").filter(Boolean)) {
      expect(line).toMatch(/^\d+\|z{500}$/);
    }
  });

  it("emits at least one line even when it alone exceeds the byte cap", () => {
    const slice = readSlice("q".repeat(10_000), 1, 10, 200);
    expect(slice.numbered.startsWith("1|q")).toBe(true);
  });

  it("treats a trailing newline as no extra line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("budgetGrepMatches", () => {
  it("caps match lists", () => {
    const matches = Array.from({ length: 100 }, (_, i) => i);
    const r = budgetGrepMatches(matches, { cap: 50 });
    expect(r.truncated).toBe(true);
    expect(r.matches).toHaveLength(50);
    expect(r.total).toBe(100);
  });
});
