import { describe, expect, it } from "vitest";

import { SteeringQueue } from "./steering";

describe("SteeringQueue", () => {
  it("queues user messages with unique ids and drains them once", () => {
    const queue = new SteeringQueue();
    const first = queue.push("one");
    const second = queue.push("two");
    expect(first?.role).toBe("user");
    expect(first?.id).not.toBe(second?.id);
    expect(queue.take().map((message) => message.parts)).toEqual([
      [{ type: "text", content: "one" }],
      [{ type: "text", content: "two" }],
    ]);
    expect(queue.take()).toEqual([]);
  });

  it("refuses steers after close and hands back the undelivered ones", () => {
    const queue = new SteeringQueue();
    queue.push("late");
    const leftovers = queue.close();
    expect(leftovers).toHaveLength(1);
    expect(queue.isClosed).toBe(true);
    expect(queue.push("too late")).toBeNull();
    expect(queue.take()).toEqual([]);
  });

  it("closes only an empty queue on closeIfEmpty", () => {
    const queue = new SteeringQueue();
    queue.push("pending");
    expect(queue.closeIfEmpty()).toBe(false);
    expect(queue.isClosed).toBe(false);
    expect(queue.take()).toHaveLength(1);
    expect(queue.closeIfEmpty()).toBe(true);
    expect(queue.push("after")).toBeNull();
  });
});
