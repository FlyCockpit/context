import type { Prisma } from "@cockpit-context/db";

/** A main run in one of these states makes its conversation "ongoing" (docs/product.md). */
export const ACTIVE_RUN_STATUSES: ("QUEUED" | "RUNNING")[] = ["QUEUED", "RUNNING"];

/** Conversations whose main run is queued or running. */
export const ongoingWhere = {
  AgentRuns: { some: { kind: "MAIN", status: { in: ACTIVE_RUN_STATUSES } } },
} satisfies Prisma.ConversationWhereInput;
