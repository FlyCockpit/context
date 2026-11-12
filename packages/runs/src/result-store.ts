import type { ResultSlice, ResultStore, StoredResult } from "@cockpit-context/agent-runtime";

/** Bounds per run: tool-result bodies are capped upstream, so this is generous. */
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_CHARS = 20_000_000;

/**
 * In-process `ResultStore` for one run (Cockpit Context has no Redis). It holds the full
 * bodies of tool results that overflowed a tool's budget or were pruned from
 * the context, so `retrieve_tool_result` can page them. It lives exactly as
 * long as the run; the oldest entries are evicted past the bounds.
 */
export class MemoryResultStore implements ResultStore {
  private readonly entries = new Map<string, StoredResult>();
  private chars = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxChars = DEFAULT_MAX_CHARS,
  ) {}

  async put(id: string, entry: StoredResult): Promise<void> {
    const previous = this.entries.get(id);
    if (previous) {
      this.chars -= previous.body.length;
      this.entries.delete(id);
    }
    this.entries.set(id, entry);
    this.chars += entry.body.length;
    while (this.entries.size > this.maxEntries || this.chars > this.maxChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.chars -= evicted?.body.length ?? 0;
    }
  }

  async get(id: string, offset: number, limit: number): Promise<ResultSlice | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const total = entry.body.length;
    const start = Math.min(Math.max(0, Math.floor(offset) || 0), total);
    const size = Math.max(0, Math.floor(limit) || 0);
    const slice = entry.body.slice(start, start + size);
    return {
      slice,
      offset: start,
      total,
      untrusted: entry.untrusted,
      hasMore: start + slice.length < total,
    };
  }
}
