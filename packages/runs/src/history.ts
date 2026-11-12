import type { AgentMessage, AgentMessagePart } from "@cockpit-context/agent-runtime";

import type { StoredTurn } from "./store";

/**
 * Seed messages for a follow-up run, rebuilt from the earlier main runs'
 * saved turns (docs/product.md).
 *
 * The rebuilt history must be something a provider accepts:
 * - every `tool-call` needs its `tool-result` and vice versa: a run stopped or
 *   interrupted mid-tool leaves a dangling call, which is dropped (with the
 *   message, if nothing else is left in it);
 * - a steering turn is saved the moment it is accepted, so its `seq` can fall
 *   between an assistant tool-call turn and that call's results. It is moved
 *   after the results, which is where the loop actually delivered it;
 * - reasoning (`thinking`) parts are dropped: they are provider-specific and
 *   not needed to continue the conversation.
 *
 * TOOL turns become assistant messages whose parts are all tool results — the
 * shape the runtime produced them in.
 */
export function historyFromTurns(turns: readonly StoredTurn[]): AgentMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (isToolCall(part)) callIds.add(part.id);
      if (isToolResult(part)) resultIds.add(part.toolCallId);
    }
  }

  const ordered: AgentMessage[] = [];
  const deferred: AgentMessage[] = [];
  const unresolved = new Set<string>();
  for (const turn of turns) {
    const parts = turn.parts.filter((part) => {
      if (part.type === "thinking") return false;
      if (isToolCall(part)) return resultIds.has(part.id);
      if (isToolResult(part)) return callIds.has(part.toolCallId);
      return true;
    });
    if (parts.length === 0) continue;
    const message: AgentMessage = {
      id: `hist-${turn.id}`,
      role: turn.role === "user" ? "user" : "assistant",
      parts,
    };
    for (const part of parts) {
      if (isToolCall(part)) unresolved.add(part.id);
      if (isToolResult(part)) unresolved.delete(part.toolCallId);
    }
    if (turn.steering && unresolved.size > 0) {
      deferred.push(message);
      continue;
    }
    ordered.push(message);
    if (unresolved.size === 0 && deferred.length > 0) ordered.push(...deferred.splice(0));
  }
  ordered.push(...deferred);
  return ordered;
}

type ToolCallPart = Extract<AgentMessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<AgentMessagePart, { type: "tool-result" }>;

function isToolCall(part: AgentMessagePart): part is ToolCallPart {
  return part.type === "tool-call" && typeof part.id === "string";
}

function isToolResult(part: AgentMessagePart): part is ToolResultPart {
  return part.type === "tool-result" && typeof part.toolCallId === "string";
}

/** The text of a message's text parts. */
export function messageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part): part is { type: "text"; content: string } => part.type === "text")
    .map((part) => part.content)
    .join("")
    .trim();
}
