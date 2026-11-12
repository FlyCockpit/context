import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook's module wires the oRPC client and i18n at import time; these
// tests cover only its pure coalescing helpers.
vi.mock("@/utils/orpc", () => ({ orpc: {} }));
vi.mock("@/utils/friendly-error", () => ({ errorCode: () => undefined }));
vi.mock("@/lib/stream-reconnect", () => ({ consumeWithReconnect: vi.fn() }));

import type { ActivityEvent } from "@/lib/conversations";

import { createRefreshCoalescer, refreshWindowFor } from "./use-run-activity";

type Change = Extract<ActivityEvent, { type: "activity" }>["change"];

function hint(change: Change): ActivityEvent {
  return { type: "activity", conversationId: "c-1", runId: "r-1", change };
}

describe("refreshWindowFor", () => {
  it("shows structural changes and the ready marker within 1.5 s", () => {
    expect(refreshWindowFor({ type: "ready" })).toBe(1_500);
    for (const change of ["created", "started", "finished"] as const) {
      expect(refreshWindowFor(hint(change))).toBe(1_500);
    }
  });

  it("spaces progress-only hints out to 5 s", () => {
    for (const change of ["progress", "phase", "helper"] as const) {
      expect(refreshWindowFor(hint(change))).toBe(5_000);
    }
  });
});

describe("createRefreshCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a burst of progress hints once, 5 s after the first", () => {
    const flush = vi.fn();
    const refresh = createRefreshCoalescer(flush);

    refresh.schedule(refreshWindowFor(hint("progress")));
    vi.advanceTimersByTime(2_000);
    refresh.schedule(refreshWindowFor(hint("helper")));
    refresh.schedule(refreshWindowFor(hint("phase")));
    vi.advanceTimersByTime(2_999);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("pulls a pending progress flush forward when a run finishes", () => {
    const flush = vi.fn();
    const refresh = createRefreshCoalescer(flush);

    refresh.schedule(refreshWindowFor(hint("progress")));
    vi.advanceTimersByTime(1_000);
    refresh.schedule(refreshWindowFor(hint("finished")));
    vi.advanceTimersByTime(1_499);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier structural flush when progress arrives in its window", () => {
    const flush = vi.fn();
    const refresh = createRefreshCoalescer(flush);

    refresh.schedule(refreshWindowFor(hint("started")));
    vi.advanceTimersByTime(500);
    refresh.schedule(refreshWindowFor(hint("progress")));
    vi.advanceTimersByTime(1_000);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("starts a new window after a flush and drops a pending one on cancel", () => {
    const flush = vi.fn();
    const refresh = createRefreshCoalescer(flush);

    refresh.schedule(1_500);
    vi.advanceTimersByTime(1_500);
    refresh.schedule(5_000);
    vi.advanceTimersByTime(5_000);
    expect(flush).toHaveBeenCalledTimes(2);

    refresh.schedule(1_500);
    refresh.cancel();
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
