import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { summarizeCheckoutJob } = await import("./job-definitions");

describe("summarizeCheckoutJob", () => {
  it("is a single-attempt job with a validated payload", () => {
    expect(summarizeCheckoutJob.type).toBe("checkout.summarize");
    expect(summarizeCheckoutJob.maxAttempts).toBe(1);
    expect(summarizeCheckoutJob.payload.safeParse({ checkoutId: "k1" }).success).toBe(false);
    expect(
      summarizeCheckoutJob.payload.safeParse({ checkoutId: "k1", ownerId: "u1", force: true })
        .success,
    ).toBe(true);
  });
});
