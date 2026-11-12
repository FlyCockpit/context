import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyCheckoutRemoval, onCheckoutRemoval } from "./removal-hooks";

const unregister: Array<() => void> = [];

afterEach(() => {
  for (const off of unregister.splice(0)) off();
  vi.restoreAllMocks();
});

describe("checkout removal hooks", () => {
  it("calls every listener with the checkout ids and awaits them", async () => {
    const seen: string[][] = [];
    unregister.push(
      onCheckoutRemoval(async (ids) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push([...ids]);
      }),
    );
    await notifyCheckoutRemoval(["chk-1", "chk-2"]);
    expect(seen).toEqual([["chk-1", "chk-2"]]);
  });

  it("logs a failing listener without blocking the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    unregister.push(
      onCheckoutRemoval(() => {
        throw new Error("boom");
      }),
    );
    unregister.push(onCheckoutRemoval(ok));
    await expect(notifyCheckoutRemoval(["chk-1"])).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith(["chk-1"]);
    expect(warn).toHaveBeenCalled();
  });

  it("unregisters, and skips an empty batch", async () => {
    const listener = vi.fn();
    const off = onCheckoutRemoval(listener);
    await notifyCheckoutRemoval([]);
    off();
    await notifyCheckoutRemoval(["chk-1"]);
    expect(listener).not.toHaveBeenCalled();
  });
});
