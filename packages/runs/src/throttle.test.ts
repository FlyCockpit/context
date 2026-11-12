import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LatestThrottle } from "./throttle";

describe("LatestThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the first value at once and only the newest one per interval after", () => {
    const emitted: number[] = [];
    const throttle = new LatestThrottle<number>(
      100,
      (value) => emitted.push(value),
      () => Date.now(),
    );
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(emitted).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([1, 3]);
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual([1, 3]);
  });

  it("drops the pending value on cancel and emits it on flush", () => {
    const emitted: string[] = [];
    const throttle = new LatestThrottle<string>(
      100,
      (value) => emitted.push(value),
      () => Date.now(),
    );
    throttle.push("a");
    throttle.push("b");
    throttle.cancel();
    vi.advanceTimersByTime(200);
    expect(emitted).toEqual(["a"]);
    throttle.push("c");
    expect(emitted).toEqual(["a", "c"]);
    throttle.push("d");
    throttle.flush();
    expect(emitted).toEqual(["a", "c", "d"]);
  });
});
