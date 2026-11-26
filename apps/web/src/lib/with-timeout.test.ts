import { afterEach, describe, expect, it, vi } from "vitest";

import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("passes a settled value through", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "load")).resolves.toBe("ok");
    await expect(withTimeout(Promise.reject(new Error("no")), 1000, "load")).rejects.toThrow("no");
  });

  it("rejects a promise that stalls past the limit", async () => {
    vi.useFakeTimers();
    const stalled = withTimeout(new Promise<never>(() => undefined), 15_000, "locale es-MX");
    const outcome = expect(stalled).rejects.toThrow("locale es-MX timed out after 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });
});
