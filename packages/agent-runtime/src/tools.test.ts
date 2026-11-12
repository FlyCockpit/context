import { describe, expect, it } from "vitest";

import {
  buildRetrieveToolResultTool,
  DEGRADED_TRUNCATION_MARKER,
  serializeRecords,
  serializeToolResult,
  serializeToolResultWithStore,
} from "./tools";
import type { ResultSlice, ResultStore, StoredResult } from "./types";

/** Redis-free in-memory ResultStore for unit tests. */
const createMemoryStore = (): ResultStore & { entries: Map<string, StoredResult> } => {
  const entries = new Map<string, StoredResult>();
  return {
    entries,
    async put(id, entry) {
      entries.set(id, entry);
    },
    async get(id, offset, limit): Promise<ResultSlice | null> {
      const entry = entries.get(id);
      if (!entry) return null;
      const total = entry.body.length;
      const start = Math.min(Math.max(offset, 0), total);
      const end = Math.min(start + Math.max(0, limit), total);
      return {
        slice: entry.body.slice(start, end),
        offset: start,
        total,
        untrusted: entry.untrusted,
        hasMore: end < total,
      };
    },
  };
};

const START_MARKER = "<<<UNTRUSTED_WEB_CONTENT_START>>>";
const END_MARKER = "<<<UNTRUSTED_WEB_CONTENT_END>>>";

const runRetrieve = (store: ResultStore, input: { id: string; offset?: number; limit?: number }) =>
  buildRetrieveToolResultTool(store).execute(
    input,
    new AbortController().signal,
  ) as Promise<string>;

describe("serializeRecords", () => {
  it("keeps whole records only — budget for ~6.5 of 10 yields 6 + count marker", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({ id: index, name: `r-${index}` }));
    // Measure size of 6 whole records + marker for 6 of 10.
    const six = JSON.stringify(records.slice(0, 6));
    const marker = "\n[showing 6 of 10 records — remainder omitted]";
    // Budget between 6 and 7 full serializations so the 7th is dropped.
    const seven = JSON.stringify(records.slice(0, 7));
    const sevenWithMarker = `${seven}\n[showing 7 of 10 records — remainder omitted]`;
    const budget = Math.floor((six.length + marker.length + sevenWithMarker.length) / 2);
    expect(budget).toBeGreaterThan(six.length + marker.length);
    expect(budget).toBeLessThan(sevenWithMarker.length);

    const out = serializeRecords(records, budget);
    expect(out).toContain("[showing 6 of 10 records — remainder omitted]");
    const jsonPart = out.slice(0, out.indexOf("\n[showing"));
    const parsed = JSON.parse(jsonPart) as unknown[];
    expect(parsed).toHaveLength(6);
    for (const record of parsed) {
      expect(() => JSON.stringify(record)).not.toThrow();
      expect(record).toEqual(expect.objectContaining({ id: expect.any(Number) }));
    }
  });

  it("returns zero records + marker when a single record exceeds the budget", () => {
    const records = [{ huge: "x".repeat(500) }];
    const out = serializeRecords(records, 80);
    expect(out).toContain("[showing 0 of 1 records — remainder omitted]");
    expect(out.startsWith("[]") || out.includes("[]")).toBe(true);
    expect(out).not.toContain("huge");
  });

  it("serializes an empty array without a remainder marker", () => {
    expect(serializeRecords([], 100)).toBe("[]");
  });

  it("preserves a header and fills the remainder with records", () => {
    const header = "Results:\n";
    const records = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const out = serializeRecords(
      records,
      header.length + JSON.stringify(records.slice(0, 2)).length + 80,
      {
        header,
      },
    );
    expect(out.startsWith(header)).toBe(true);
  });
});

describe("serializeToolResult", () => {
  it("byte-slices plain strings with the [truncated] marker (regression)", () => {
    expect(serializeToolResult("abcdefghij", 9)).toBe("[truncated]");
    const big = "x".repeat(100);
    const out = serializeToolResult(big, 40);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith("x")).toBe(true);
  });
});

describe("serializeToolResultWithStore", () => {
  it("inlines a result under the cap without storing anything", async () => {
    const store = createMemoryStore();
    const small = "hello";
    const out = await serializeToolResultWithStore(small, 40, { store });
    expect(out).toBe("hello");
    expect(store.entries.size).toBe(0);
  });

  it("stores an overflowing body and returns a head + stable marker", async () => {
    const store = createMemoryStore();
    const body = "a".repeat(500);
    const out = await serializeToolResultWithStore(body, 100, { store });

    const match = out.match(
      /\[stored result id=([0-9a-f]+) total=(\d+) untrusted=(true|false); retrieve with retrieve_tool_result\]$/,
    );
    expect(match).not.toBeNull();
    const [, id, total, untrusted] = match ?? [];
    expect(Number(total)).toBe(500);
    expect(untrusted).toBe("false");
    // The stored entry is the full body and is retrievable in one shot.
    const full = await store.get(id ?? "", 0, 500);
    expect(full?.slice).toBe(body);
    // The inline head respects the cap.
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("uses whole-record heads for array values when stored", async () => {
    const store = createMemoryStore();
    const records = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      title: `hit-${index}-${"y".repeat(30)}`,
    }));
    const out = await serializeToolResultWithStore(records, 200, { store });
    expect(out).toMatch(/\[stored result id=/);
    const head = out.slice(0, out.indexOf("\n[stored result"));
    // Head must be valid JSON array of whole objects — never mid-record garbage.
    const parsed = JSON.parse(head) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(20);
    for (const record of parsed) {
      expect(record).toEqual(
        expect.objectContaining({ id: expect.any(Number), title: expect.stringMatching(/^hit-/) }),
      );
    }
  });

  it("wraps the head of an untrusted overflow with the untrusted markers", async () => {
    const store = createMemoryStore();
    const body = "b".repeat(500);
    const out = await serializeToolResultWithStore(body, 200, { store, untrusted: true });
    expect(out).toContain(START_MARKER);
    expect(out).toContain(END_MARKER);
    expect(out).toContain("untrusted=true");
    // Stored entry preserves the untrusted flag.
    const id = out.match(/id=([0-9a-f]+)/)?.[1] ?? "";
    expect(store.entries.get(id)?.untrusted).toBe(true);
  });

  it("degrades with an explicit NOT-retrievable marker when the store write fails", async () => {
    const failing: ResultStore = {
      async put() {
        throw new Error("redis down");
      },
      async get() {
        return null;
      },
    };
    const body = "c".repeat(500);
    const out = await serializeToolResultWithStore(body, 200, { store: failing });
    expect(out).toContain("NOT retrievable");
    expect(out).toContain(DEGRADED_TRUNCATION_MARKER.trim());
    expect(out).not.toContain("[stored result");
  });

  it("degrades with NOT-retrievable when no store is configured", async () => {
    const body = "d".repeat(500);
    const out = await serializeToolResultWithStore(body, 120, {});
    expect(out).toContain("NOT retrievable");
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it("healthy store marker text is unchanged (snapshot)", async () => {
    const store = createMemoryStore();
    const body = "e".repeat(300);
    const out = await serializeToolResultWithStore(body, 100, { store });
    expect(out).toMatch(
      /\[stored result id=[0-9a-f]+ total=300 untrusted=false; retrieve with retrieve_tool_result\]$/,
    );
  });

  it("keeps untrusted markers balanced around record-truncated array heads", async () => {
    const store = createMemoryStore();
    const records = Array.from({ length: 30 }, (_, index) => ({ n: index, t: "z".repeat(40) }));
    const out = await serializeToolResultWithStore(records, 250, { store, untrusted: true });
    expect(out).toContain(START_MARKER);
    expect(out).toContain(END_MARKER);
    expect(out.indexOf(START_MARKER)).toBeLessThan(out.indexOf(END_MARKER));
    // Store marker sits outside the untrusted wrap.
    expect(out.indexOf(END_MARKER)).toBeLessThan(out.indexOf("[stored result"));
  });
});

describe("retrieve_tool_result", () => {
  it("returns a bounded first slice", async () => {
    const store = createMemoryStore();
    await store.put("id1", { body: "0123456789", untrusted: false });
    const out = await runRetrieve(store, { id: "id1", limit: 4 });
    expect(out).toContain("0123");
    expect(out).toContain("offset=0");
    expect(out).toContain("total=10");
    expect(out).toContain("more available");
  });

  it("returns a clamped middle window", async () => {
    const store = createMemoryStore();
    await store.put("id1", { body: "0123456789", untrusted: false });
    const out = await runRetrieve(store, { id: "id1", offset: 4, limit: 3 });
    expect(out).toContain("456");
    expect(out).toContain("offset=4");
  });

  it("returns an empty slice + end-of-body marker past the end, not an error", async () => {
    const store = createMemoryStore();
    await store.put("id1", { body: "0123456789", untrusted: false });
    const out = await runRetrieve(store, { id: "id1", offset: 999, limit: 10 });
    expect(out).toContain("end of body");
    expect(out).not.toContain("error");
    expect(out).toContain("returned=0");
  });

  it("wraps every returned slice of an untrusted entry (the security fix)", async () => {
    const store = createMemoryStore();
    await store.put("id1", { body: "secret instructions everywhere", untrusted: true });
    const out = await runRetrieve(store, { id: "id1", limit: 5 });
    expect(out).toContain(START_MARKER);
    expect(out).toContain(END_MARKER);
    // The wrapped slice contents sit between the markers.
    expect(out.indexOf(START_MARKER)).toBeLessThan(out.indexOf("secre"));
    expect(out.indexOf("secre")).toBeLessThan(out.indexOf(END_MARKER));
  });

  it("does not wrap a trusted entry's slice", async () => {
    const store = createMemoryStore();
    await store.put("id1", { body: "trusted body", untrusted: false });
    const out = await runRetrieve(store, { id: "id1", limit: 6 });
    expect(out).not.toContain(START_MARKER);
    expect(out).toContain("truste");
  });

  it("returns a structured error for an unknown or expired id", async () => {
    const store = createMemoryStore();
    const result = (await buildRetrieveToolResultTool(store).execute(
      { id: "missing" },
      new AbortController().signal,
    )) as {
      error: string;
    };
    expect(result.error).toBe("expired or unknown result id");
  });
});
