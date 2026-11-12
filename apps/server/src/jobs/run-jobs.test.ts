import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const engine = vi.hoisted(() => ({ summarizeCheckout: vi.fn() }));
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: () => engine }));

const { summarizeCheckoutHandler } = await import("./run-jobs.js");

const job = (payload: { checkoutId: string; ownerId: string; packageId?: string }) => ({
  id: "j1",
  type: "checkout.summarize",
  payload,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
});

describe("summarizeCheckoutHandler", () => {
  it("starts the engine's summary with the job's abort signal and returns", async () => {
    engine.summarizeCheckout.mockResolvedValue({ started: true, runId: "r1" });
    const input = job({ checkoutId: "k1", ownerId: "u1", packageId: "p1" });
    await expect(summarizeCheckoutHandler.handler(input)).resolves.toBeUndefined();
    expect(engine.summarizeCheckout).toHaveBeenCalledWith(input.payload, input.signal);
  });

  it("succeeds when the engine skips the summary", async () => {
    engine.summarizeCheckout.mockResolvedValue({ started: false });
    await expect(
      summarizeCheckoutHandler.handler(job({ checkoutId: "k1", ownerId: "u1" })),
    ).resolves.toBeUndefined();
  });

  it("fails the job when the summary run cannot be started", async () => {
    engine.summarizeCheckout.mockRejectedValue(new Error("database down"));
    await expect(
      summarizeCheckoutHandler.handler(job({ checkoutId: "k1", ownerId: "u1" })),
    ).rejects.toThrow("database down");
  });
});
