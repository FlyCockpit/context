import { describe, expect, it } from "vitest";

import { createKeyedSlots, createMcpAdmissionGate } from "./admission";

describe("createKeyedSlots", () => {
  it("caps holders per key, keeps keys apart and frees a slot once per release", () => {
    const slots = createKeyedSlots(2);
    const first = slots.tryAcquire("user-a");
    const second = slots.tryAcquire("user-a");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(slots.tryAcquire("user-a")).toBeNull();
    expect(slots.held("user-a")).toBe(2);

    const other = slots.tryAcquire("user-b");
    expect(other).not.toBeNull();

    first?.();
    first?.();
    expect(slots.held("user-a")).toBe(1);
    const third = slots.tryAcquire("user-a");
    expect(third).not.toBeNull();
    expect(slots.tryAcquire("user-a")).toBeNull();

    second?.();
    third?.();
    other?.();
    expect(slots.held("user-a")).toBe(0);
    expect(slots.held("user-b")).toBe(0);
  });

  it("reads a cap given as a function on every acquire", () => {
    let max = 1;
    const slots = createKeyedSlots(() => max);
    const first = slots.tryAcquire("user-a");
    expect(slots.tryAcquire("user-a")).toBeNull();
    max = 2;
    const second = slots.tryAcquire("user-a");
    expect(second).not.toBeNull();
    expect(slots.tryAcquire("user-a")).toBeNull();
    first?.();
    second?.();
  });
});

describe("createMcpAdmissionGate", () => {
  it("counts permits, aborts them on close and resolves once all are released", async () => {
    const gate = createMcpAdmissionGate();
    const first = gate.admit();
    const second = gate.admit();
    expect(gate.outstanding).toBe(2);
    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    expect(gate.closed).toBe(true);
    expect(first?.controller.signal.aborted).toBe(true);
    expect(gate.admit()).toBeNull();
    first?.release();
    first?.release();
    await Promise.resolve();
    expect(closed).toBe(false);
    second?.release();
    await closing;
    expect(closed).toBe(true);
    expect(gate.outstanding).toBe(0);
  });

  it("closes at once when nothing is outstanding", async () => {
    await expect(createMcpAdmissionGate().close()).resolves.toBeUndefined();
  });
});
