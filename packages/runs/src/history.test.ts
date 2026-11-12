import { describe, expect, it } from "vitest";

import { historyFromTurns, messageText } from "./history";
import type { StoredTurn } from "./store";

let counter = 0;
const turn = (
  role: StoredTurn["role"],
  parts: StoredTurn["parts"],
  steering = false,
): StoredTurn => {
  counter += 1;
  return { id: `t${counter}`, runId: "r1", seq: counter, role, parts, steering };
};
const textPart = (content: string) => ({ type: "text", content });
const call = (id: string) => ({
  type: "tool-call",
  id,
  name: "grep",
  arguments: "{}",
  state: "done",
});
const resultPart = (id: string) => ({
  type: "tool-result",
  toolCallId: id,
  content: "ok",
  state: "done",
});

describe("historyFromTurns", () => {
  it("maps roles and keeps order, with tool turns as assistant messages", () => {
    const history = historyFromTurns([
      turn("user", [textPart("q")]),
      turn("assistant", [call("c1")]),
      turn("tool", [resultPart("c1")]),
      turn("assistant", [textPart("answer")]),
    ]);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    expect(history[0]?.id).toMatch(/^hist-/);
  });

  it("drops dangling tool calls and orphan results, and thinking parts", () => {
    const history = historyFromTurns([
      turn("user", [textPart("q")]),
      turn("assistant", [textPart("let me look"), call("c1"), { type: "thinking", content: "hm" }]),
      turn("assistant", [call("c2")]),
      turn("tool", [resultPart("ghost")]),
    ]);
    expect(history).toHaveLength(2);
    expect(history[1]?.parts).toEqual([textPart("let me look")]);
  });

  it("moves a steering turn saved mid-tool-call after the call's results", () => {
    const history = historyFromTurns([
      turn("user", [textPart("q")]),
      turn("assistant", [call("c1")]),
      turn("user", [textPart("steer")], true),
      turn("tool", [resultPart("c1")]),
      turn("assistant", [textPart("done")]),
    ]);
    expect(history.map((message) => messageText(message) || message.parts[0]?.type)).toEqual([
      "q",
      "tool-call",
      "tool-result",
      "steer",
      "done",
    ]);
  });
});

describe("messageText", () => {
  it("joins text parts and ignores the rest", () => {
    expect(
      messageText({ id: "m", role: "assistant", parts: [textPart("a"), call("c"), textPart("b")] }),
    ).toBe("ab");
    expect(messageText(undefined)).toBe("");
  });
});
