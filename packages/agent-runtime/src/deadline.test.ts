import { describe, expect, it } from "vitest";

import {
  DEADLINE_ABORT_REASON,
  isDeadlineAbort,
  resolveDeadlineAt,
  startDeadline,
} from "./deadline";

describe("resolveDeadlineAt", () => {
  it("returns null when both knobs are absent or null (uncapped in time)", () => {
    expect(resolveDeadlineAt({}, 1_000)).toBeNull();
    expect(resolveDeadlineAt({ timeoutMs: null, deadlineAt: null }, 1_000)).toBeNull();
  });

  it("converts a relative timeout into an absolute deadline", () => {
    expect(resolveDeadlineAt({ timeoutMs: 500 }, 1_000)).toBe(1_500);
  });

  it("takes the earlier of a per-node timeout and a per-run absolute deadline", () => {
    expect(resolveDeadlineAt({ timeoutMs: 5_000, deadlineAt: 2_000 }, 1_000)).toBe(2_000);
    expect(resolveDeadlineAt({ timeoutMs: 500, deadlineAt: 9_000 }, 1_000)).toBe(1_500);
  });

  it("ignores non-finite values rather than producing NaN deadlines", () => {
    expect(resolveDeadlineAt({ timeoutMs: Number.POSITIVE_INFINITY }, 1_000)).toBeNull();
    expect(resolveDeadlineAt({ timeoutMs: Number.NaN, deadlineAt: 2_000 }, 1_000)).toBe(2_000);
  });
});

describe("startDeadline", () => {
  it("is inert when uncapped", () => {
    const controller = new AbortController();
    const handle = startDeadline({}, controller);
    expect(handle.deadlineAt).toBeNull();
    expect(handle.expired()).toBe(false);
    handle.cancel();
    expect(controller.signal.aborted).toBe(false);
  });

  it("reports an already-elapsed deadline as expired without waiting", () => {
    const controller = new AbortController();
    const handle = startDeadline({ deadlineAt: Date.now() - 1_000 }, controller);
    expect(handle.expired()).toBe(true);
    handle.cancel();
  });

  it("aborts the shared controller with the deadline reason on expiry", async () => {
    const controller = new AbortController();
    const handle = startDeadline({ timeoutMs: 1 }, controller);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(controller.signal.aborted).toBe(true);
    expect(isDeadlineAbort(controller.signal.reason)).toBe(true);
    expect(controller.signal.reason).toBe(DEADLINE_ABORT_REASON);
    expect(handle.expired()).toBe(true);
    handle.cancel();
  });

  it("does not abort after cancel", async () => {
    const controller = new AbortController();
    const handle = startDeadline({ timeoutMs: 1 }, controller);
    handle.cancel();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not mistake a caller-requested cancel for a deadline", () => {
    const controller = new AbortController();
    controller.abort("run cancelled");
    expect(isDeadlineAbort(controller.signal.reason)).toBe(false);
  });
});
