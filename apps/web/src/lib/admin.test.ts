import { describe, expect, it } from "vitest";

import {
  formatSeconds,
  jobStatusInput,
  jobTimestamp,
  repositoryLeased,
  storageFraction,
  storageLevel,
} from "@/lib/admin";

describe("storageLevel", () => {
  it("is ok below the prune target, near from it, over past the cap", () => {
    expect(storageLevel(0, 1000)).toBe("ok");
    expect(storageLevel(899, 1000)).toBe("ok");
    expect(storageLevel(900, 1000)).toBe("near");
    expect(storageLevel(1000, 1000)).toBe("near");
    expect(storageLevel(1001, 1000)).toBe("over");
  });

  it("treats a zero cap as over once anything is stored", () => {
    expect(storageLevel(0, 0)).toBe("ok");
    expect(storageLevel(1, 0)).toBe("over");
  });
});

describe("storageFraction", () => {
  it("clamps to 0..1", () => {
    expect(storageFraction(250, 1000)).toBe(0.25);
    expect(storageFraction(5000, 1000)).toBe(1);
    expect(storageFraction(-5, 1000)).toBe(0);
    expect(storageFraction(0, 0)).toBe(0);
    expect(storageFraction(3, 0)).toBe(1);
  });
});

describe("jobStatusInput", () => {
  it("drops the status for the all filter", () => {
    expect(jobStatusInput("all")).toBeUndefined();
    expect(jobStatusInput("failed")).toBe("failed");
  });
});

describe("jobTimestamp", () => {
  const f = new Date("2026-10-01T00:00:03Z");
  const l = new Date("2026-10-01T00:00:02Z");
  const r = new Date("2026-10-01T00:00:01Z");
  const base = { finishedAt: f, lockedAt: l, runAt: r };

  it("shows when a job finished, started or may next run", () => {
    expect(jobTimestamp({ ...base, status: "succeeded" })).toEqual({ kind: "finished", at: f });
    expect(jobTimestamp({ ...base, status: "failed" })).toEqual({ kind: "finished", at: f });
    expect(jobTimestamp({ ...base, status: "running" })).toEqual({ kind: "started", at: l });
    expect(jobTimestamp({ ...base, status: "queued" })).toEqual({ kind: "runs", at: r });
  });
});

describe("repositoryLeased", () => {
  it("is true when any listed checkout is leased", () => {
    expect(repositoryLeased({ checkouts: [] })).toBe(false);
    const checkout = {
      id: "c",
      sha: "a".repeat(40),
      resolvedFrom: null,
      status: "ready" as const,
      diskBytes: 1,
      lastUsedAt: null,
    };
    expect(repositoryLeased({ checkouts: [{ ...checkout, leased: false }] })).toBe(false);
    expect(
      repositoryLeased({
        checkouts: [
          { ...checkout, leased: false },
          { ...checkout, id: "d", leased: true },
        ],
      }),
    ).toBe(true);
  });
});

describe("formatSeconds", () => {
  it("uses the largest exact unit", () => {
    expect(formatSeconds(600, "en-US")).toBe("10 minutes");
    expect(formatSeconds(7200, "en-US")).toBe("2 hours");
    expect(formatSeconds(90, "en-US")).toBe("90 seconds");
    expect(formatSeconds(0, "en-US")).toBe("0 seconds");
  });
});
