import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backoffDelayMs, DEFAULT_BACKOFF, defineJob } from "./define";

describe("defineJob", () => {
  it("applies defaults", () => {
    const job = defineJob("repo.fetch", z.object({ id: z.string() }));
    expect(job).toMatchObject({ type: "repo.fetch", maxAttempts: 3, backoff: DEFAULT_BACKOFF });
  });

  it("rejects unstable type names and nonsensical attempt counts", () => {
    expect(() => defineJob("Repo Fetch", z.object({}))).toThrow(/lowercase/);
    expect(() => defineJob("repo.fetch", z.object({}), { maxAttempts: 0 })).toThrow(/maxAttempts/);
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and caps", () => {
    const policy = { baseMs: 1_000, maxMs: 5_000 };
    expect(backoffDelayMs(policy, 1)).toBe(1_000);
    expect(backoffDelayMs(policy, 2)).toBe(2_000);
    expect(backoffDelayMs(policy, 3)).toBe(4_000);
    expect(backoffDelayMs(policy, 4)).toBe(5_000);
    expect(backoffDelayMs(policy, 40)).toBe(5_000);
  });
});
