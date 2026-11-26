import prisma, { type Prisma } from "@cockpit-context/db";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { reasonError } from "../lib/domain-errors";
import { findOwnedOrThrow } from "../lib/ownership";
import { entityId } from "../lib/schemas";
import { retrySerializable } from "../lib/serializable";
import { conversationSelect, serializeConversationRows } from "./conversations";

/**
 * Conversations pinned to the signed-in home, in the user's own order
 * (docs/product.md). Owner-scoped like conversations: a user pins only a
 * conversation they own, and every read and write also requires
 * `Conversation.ownerId = userId`, so a pin never shows (or counts toward the
 * limit for) a conversation its user cannot see. A deleted conversation or
 * user takes its pins with it (FK cascade).
 */

/** Pins one user may hold: the home's Pinned section stays one glance. */
const MAX_PINS = 12;

/** Attempts at a Serializable pin write before giving up with CONFLICT. */
const WRITE_ATTEMPTS = 3;

/** The caller's pins that still point at a conversation they own. */
function visiblePinsWhere(userId: string) {
  return { userId, Conversation: { ownerId: userId } } satisfies Prisma.ConversationPinWhereInput;
}

/** Pins whose conversation is no longer the caller's: removed on the next write. */
function lostPinsWhere(userId: string) {
  return {
    userId,
    Conversation: { ownerId: { not: userId } },
  } satisfies Prisma.ConversationPinWhereInput;
}

function busy() {
  return reasonError(
    "CONFLICT",
    "PINS_BUSY",
    "Your pins were being changed at the same time. Try again.",
  );
}

function serializable<T>(write: (tx: Prisma.TransactionClient) => Promise<T>) {
  return retrySerializable(() => prisma.$transaction(write, { isolationLevel: "Serializable" }), {
    attempts: WRITE_ATTEMPTS,
    onExhausted: busy,
  });
}

const orderedIds = z
  .array(entityId)
  .max(MAX_PINS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Each conversation once" });

export const pinsRouter = {
  /** The caller's pinned conversations, in their order, as list rows. */
  list: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const pins = await prisma.conversationPin.findMany({
      where: visiblePinsWhere(userId),
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      // pagination:audited — bounded by MAX_PINS (pin refuses more)
      take: MAX_PINS,
      select: { Conversation: { select: conversationSelect } },
    });
    return {
      items: await serializeConversationRows(
        userId,
        pins.map((pin) => pin.Conversation),
      ),
      limit: MAX_PINS,
    };
  }),

  /**
   * Pin an own conversation last. Pinning one that is already pinned is a
   * no-op. NOT_FOUND for a conversation that is not the caller's;
   * CONFLICT / PIN_LIMIT at {@link MAX_PINS}.
   */
  pin: protectedProcedure.input(z.object({ id: entityId })).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    return serializable(async (tx) => {
      const conversation = await findOwnedOrThrow({
        find: (args) => tx.conversation.findFirst(args),
        args: { where: { id: input.id }, select: { id: true } },
        owner: { field: "ownerId", id: userId },
        notFound: "Conversation not found.",
      });
      await tx.conversationPin.deleteMany({ where: lostPinsWhere(userId) });
      const existing = await tx.conversationPin.findFirst({
        where: { userId, conversationId: conversation.id },
        select: { id: true },
      });
      if (existing) return { pinned: true as const };
      const pins = await tx.conversationPin.aggregate({
        where: visiblePinsWhere(userId),
        _count: { _all: true },
        _max: { position: true },
      });
      if (pins._count._all >= MAX_PINS) {
        throw reasonError(
          "CONFLICT",
          "PIN_LIMIT",
          `You can pin up to ${MAX_PINS} conversations. Unpin one first.`,
        );
      }
      await tx.conversationPin.create({
        data: { userId, conversationId: conversation.id, position: (pins._max.position ?? -1) + 1 },
        select: { id: true },
      });
      return { pinned: true as const };
    });
  }),

  /** Unpin one of the caller's pins. Unpinning what is not pinned is a no-op. */
  unpin: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      await prisma.conversationPin.deleteMany({ where: { userId, conversationId: input.id } });
      return { pinned: false as const };
    }),

  /**
   * Put the caller's pins in this order: `ids` lists every pinned
   * conversation exactly once. CONFLICT / PINS_CHANGED when it does not
   * match the pins as they are now (pinned or unpinned elsewhere): reload
   * and try again.
   */
  reorder: protectedProcedure
    .input(z.object({ ids: orderedIds }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return serializable(async (tx) => {
        await tx.conversationPin.deleteMany({ where: lostPinsWhere(userId) });
        const current = await tx.conversationPin.findMany({
          where: visiblePinsWhere(userId),
          // pagination:audited — bounded by MAX_PINS (pin refuses more)
          take: MAX_PINS + 1,
          select: { conversationId: true },
        });
        const pinned = new Set(current.map((pin) => pin.conversationId));
        if (pinned.size !== input.ids.length || input.ids.some((id) => !pinned.has(id))) {
          throw reasonError(
            "CONFLICT",
            "PINS_CHANGED",
            "Your pins changed somewhere else. Reload and try again.",
          );
        }
        for (const [position, conversationId] of input.ids.entries()) {
          await tx.conversationPin.updateMany({
            where: { userId, conversationId },
            data: { position },
          });
        }
        return { ok: true as const };
      });
    }),
};
