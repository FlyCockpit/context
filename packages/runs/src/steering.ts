import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@cockpit-context/agent-runtime";

/**
 * A main run's in-memory steering queue. `push` is synchronous so accept /
 * refuse is decided atomically against `close`: once the loop enters its
 * final synthesis or returns, `close()` makes every later steer fail with
 * `run_finished`. `take` is the agent-runtime `takeSteeringMessages` hook.
 */
export class SteeringQueue {
  private queue: AgentMessage[] = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  /** Queue an owner's instruction; `null` when the run no longer accepts steering. */
  push(text: string): AgentMessage | null {
    if (this.closed) return null;
    const message: AgentMessage = {
      id: `steer-${randomUUID()}`,
      role: "user",
      parts: [{ type: "text", content: text }],
    };
    this.queue.push(message);
    return message;
  }

  /** Drain everything queued so far. */
  readonly take = (): AgentMessage[] => this.queue.splice(0);

  /**
   * Close only if nothing is waiting. Called when the model ends a turn
   * without tool calls: the runtime's one extra take that follows either
   * finds queued steers (and dispatches again) or ends the loop, so closing
   * an empty queue here leaves no window in which a steer is accepted but
   * never read. `true` when it closed.
   */
  closeIfEmpty(): boolean {
    if (this.queue.length > 0) return false;
    this.closed = true;
    return true;
  }

  /** Refuse further steers; returns anything accepted but never delivered. */
  close(): AgentMessage[] {
    this.closed = true;
    return this.queue.splice(0);
  }
}
