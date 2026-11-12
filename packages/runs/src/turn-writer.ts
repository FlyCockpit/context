import type { AgentMessage, AgentMessagePart } from "@cockpit-context/agent-runtime";
import { type ExploreTurn, FORCE_FINAL_MESSAGE_ID } from "@cockpit-context/explore";

import type { TurnRole, TurnView } from "./events";
import type { RunStore } from "./store";

/**
 * Persists one run's turns in order. `seq` is allocated synchronously when a
 * turn is recorded, so turns land in the order they happened even though the
 * inserts are chained in the background (the loop is never blocked on a
 * write); `flush()` waits for them before the run is finalized.
 *
 * Skipped announcements:
 * - the first `skipSeeds` (the loop re-announces its seed messages: earlier
 *   runs' history and the user message the engine already saved);
 * - ids saved directly with `append` (steering turns, written the moment they
 *   are accepted, are announced again when the loop delivers them);
 * - the synthetic force-final prompt and system messages (not conversation).
 */
export class TurnWriter {
  private nextSeq = 0;
  private skipSeeds: number;
  private readonly saved = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly runId: string,
    private readonly store: RunStore,
    private readonly publish: (turn: TurnView) => void,
    options: { skipSeeds?: number } = {},
  ) {
    this.skipSeeds = options.skipSeeds ?? 0;
  }

  /** Save a message now, outside the loop's announcements. */
  append(message: AgentMessage, role: TurnRole, steering = false): TurnView {
    this.saved.add(message.id);
    return this.write(message, role, steering);
  }

  /** The `onTurn` hook. Returns the saved turn, or `null` when skipped. */
  readonly record = (turn: ExploreTurn): TurnView | null => {
    if (this.skipSeeds > 0) {
      this.skipSeeds -= 1;
      return null;
    }
    const { message } = turn;
    if (this.saved.has(message.id) || message.id === FORCE_FINAL_MESSAGE_ID) return null;
    const role = turnRole(turn.role);
    if (!role) return null;
    this.saved.add(message.id);
    return this.write(message, role, false);
  };

  /** Every write recorded so far has settled. */
  flush(): Promise<void> {
    return this.chain;
  }

  private write(message: AgentMessage, role: TurnRole, steering: boolean): TurnView {
    // A snapshot taken now: the insert runs later on the chain, and the loop
    // keeps the message (context pruning rewrites tool-result bodies in place
    // on later dispatches), so the saved and published turn must not alias it.
    const view: TurnView = {
      seq: this.nextSeq,
      role,
      parts: snapshotParts(message.parts),
      steering,
    };
    this.nextSeq += 1;
    this.chain = this.chain
      .then(() => this.store.insertTurn({ runId: this.runId, ...view }))
      .catch((error: unknown) => {
        console.error(`[runs] could not save turn ${view.seq} of run ${this.runId}`, error);
      });
    this.publish(view);
    return view;
  }
}

/**
 * A deep copy of the parts as JSON: exactly what the `parts` column stores
 * (`partsToJson` serializes the same way), so what is published matches what
 * a later read returns.
 */
function snapshotParts(parts: AgentMessagePart[]): AgentMessagePart[] {
  const copy: AgentMessagePart[] = JSON.parse(JSON.stringify(parts));
  return copy;
}

function turnRole(role: string): TurnRole | null {
  if (role === "user" || role === "assistant" || role === "tool") return role;
  return null;
}
