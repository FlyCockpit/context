import { describe, expect, it } from "vitest";

import { formatPerCallRange, resolveHelperLimits } from "./helper-limits";

describe("resolveHelperLimits", () => {
  it("defaults to 5 at once, 10 in total, 2–5 per call", () => {
    expect(resolveHelperLimits()).toEqual({
      maxParallel: 5,
      maxHelpers: 10,
      minPerCall: 2,
      maxPerCall: 5,
    });
  });

  it("clamps the parallel limit to the total", () => {
    expect(resolveHelperLimits({ maxParallelHelpers: 8, maxHelpers: 3 })).toMatchObject({
      maxParallel: 3,
      maxPerCall: 3,
    });
  });

  it("lowers the per-call minimum when only one helper may run", () => {
    expect(resolveHelperLimits({ maxParallelHelpers: 1 })).toMatchObject({
      maxParallel: 1,
      minPerCall: 1,
      maxPerCall: 1,
    });
  });

  it("floors fractions and lifts zero or negative values to 1", () => {
    expect(resolveHelperLimits({ maxParallelHelpers: 2.7, maxHelpers: 0 })).toMatchObject({
      maxParallel: 1,
      maxHelpers: 1,
    });
    expect(resolveHelperLimits({ maxParallelHelpers: Number.NaN })).toMatchObject({
      maxParallel: 5,
    });
  });
});

describe("formatPerCallRange", () => {
  it("prints a range, or one number when the bounds meet", () => {
    expect(formatPerCallRange(resolveHelperLimits())).toBe("2–5");
    expect(formatPerCallRange(resolveHelperLimits({ maxParallelHelpers: 2 }))).toBe("2");
  });
});
