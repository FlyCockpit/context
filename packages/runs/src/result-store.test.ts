import { describe, expect, it } from "vitest";

import { MemoryResultStore } from "./result-store";

describe("MemoryResultStore", () => {
  it("returns clamped slices of a stored body", async () => {
    const store = new MemoryResultStore();
    await store.put("r1", { body: "0123456789", untrusted: true });
    await expect(store.get("r1", 2, 3)).resolves.toEqual({
      slice: "234",
      offset: 2,
      total: 10,
      untrusted: true,
      hasMore: true,
    });
    await expect(store.get("r1", 900, 5)).resolves.toMatchObject({
      slice: "",
      offset: 10,
      hasMore: false,
    });
    await expect(store.get("missing", 0, 1)).resolves.toBeNull();
  });

  it("evicts the oldest entries past its bounds", async () => {
    const store = new MemoryResultStore(2, 100);
    await store.put("a", { body: "a", untrusted: false });
    await store.put("b", { body: "b", untrusted: false });
    await store.put("c", { body: "c", untrusted: false });
    await expect(store.get("a", 0, 1)).resolves.toBeNull();
    await expect(store.get("c", 0, 1)).resolves.toMatchObject({ slice: "c" });

    const small = new MemoryResultStore(10, 5);
    await small.put("x", { body: "xxxx", untrusted: false });
    await small.put("y", { body: "yy", untrusted: false });
    await expect(small.get("x", 0, 1)).resolves.toBeNull();
    await expect(small.get("y", 0, 2)).resolves.toMatchObject({ slice: "yy" });
  });
});
