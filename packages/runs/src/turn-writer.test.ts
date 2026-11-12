import { FORCE_FINAL_MESSAGE_ID } from "@cockpit-context/explore";
import { describe, expect, it, vi } from "vitest";

import type { TurnView } from "./events";
import { MemoryRunStore } from "./test-support/memory-run-store";
import { TurnWriter } from "./turn-writer";

const message = (id: string, content = id) => ({
  id,
  role: "assistant" as const,
  parts: [{ type: "text", content }],
});

describe("TurnWriter", () => {
  it("saves turns with consecutive seqs, skipping seeds, repeats and the force-final prompt", async () => {
    const store = new MemoryRunStore();
    const published: TurnView[] = [];
    const writer = new TurnWriter("run1", store, (turn) => published.push(turn), {
      skipSeeds: 2,
    });
    writer.append({ ...message("user-1"), role: "user" }, "user");
    writer.record({ seq: 0, role: "user", message: { ...message("h1"), role: "user" } });
    writer.record({ seq: 1, role: "user", message: { ...message("q"), role: "user" } });
    writer.record({ seq: 2, role: "assistant", message: message("a1") });
    writer.record({ seq: 3, role: "assistant", message: message("a1") });
    writer.record({
      seq: 4,
      role: "user",
      message: { ...message(FORCE_FINAL_MESSAGE_ID), role: "user" },
    });
    writer.record({ seq: 5, role: "tool", message: message("t1") });
    writer.record({ seq: 6, role: "system", message: message("s") });
    await writer.flush();
    expect(store.turnsOf("run1").map((turn) => [turn.seq, turn.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "tool"],
    ]);
    expect(published.map((turn) => turn.seq)).toEqual([0, 1, 2]);
  });

  it("skips the loop's later announcement of a steer it already saved", async () => {
    const store = new MemoryRunStore();
    const writer = new TurnWriter("run1", store, () => {});
    const steer = {
      id: "steer-1",
      role: "user" as const,
      parts: [{ type: "text", content: "go" }],
    };
    expect(writer.append(steer, "user", true)).toMatchObject({ seq: 0, steering: true });
    expect(writer.record({ seq: 9, role: "user", message: steer })).toBeNull();
    await writer.flush();
    expect(store.turnsOf("run1")).toHaveLength(1);
  });

  it("saves and publishes the parts as they were when recorded, not later in-place edits", async () => {
    const store = new MemoryRunStore();
    const published: TurnView[] = [];
    const writer = new TurnWriter("run1", store, (turn) => published.push(turn));
    const toolTurn = {
      id: "t1",
      role: "user" as const,
      parts: [{ type: "tool-result", toolCallId: "c1", content: "BIG BODY", state: "done" }],
    };
    // The insert is chained, so it runs after this synchronous mutation.
    writer.record({ seq: 0, role: "tool", message: toolTurn });
    const [part] = toolTurn.parts;
    if (part) part.content = "[stored result id=r1]";
    toolTurn.parts.push({ type: "text", content: "added later", toolCallId: "", state: "" });
    await writer.flush();
    const expected = [
      { type: "tool-result", toolCallId: "c1", content: "BIG BODY", state: "done" },
    ];
    expect(store.turnsOf("run1")[0]?.parts).toEqual(expected);
    expect(published[0]?.parts).toEqual(expected);
    expect(published[0]?.parts).not.toBe(toolTurn.parts);
  });

  it("keeps going when an insert fails", async () => {
    const store = new MemoryRunStore();
    const insert = vi.spyOn(store, "insertTurn").mockRejectedValueOnce(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = new TurnWriter("run1", store, () => {});
    writer.record({ seq: 0, role: "assistant", message: message("a1") });
    writer.record({ seq: 1, role: "assistant", message: message("a2") });
    await writer.flush();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(store.turnsOf("run1").map((turn) => turn.seq)).toEqual([1]);
    error.mockRestore();
  });
});
