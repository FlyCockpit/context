import prisma from "@cockpit-context/db";
import {
  confirmKnownHost,
  deleteKnownHost,
  type KnownHostView,
  knownHostSelect,
  PINNED_HOST_KEYS,
  scanKnownHost,
} from "@cockpit-context/repos";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { withDomainErrors } from "../lib/domain-errors";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { cockpitContextRateBudget } from "../lib/rate-budgets";
import { entityId } from "../lib/schemas";

/**
 * Confirmed SSH host keys for git hosts that are not pinned in code
 * (docs/product.md). `scan` is outbound TCP to a
 * user-named host: the git layer refuses private, loopback and link-local
 * addresses and scans the checked address, not the name.
 */

/**
 * One point per scan: an `ssh-keyscan` connection to a user-named host.
 * The default 20 per 10 minutes (`COCKPIT_CONTEXT_HOST_SCANS_PER_10_MINUTES`) covers confirming a few hosts with retries while keeping
 * the server from being used as a port-22 probe. Fail-closed: outbound
 * traffic on user input.
 */
const consumeScanBudget = createProcedureBudget({
  keyPrefix: "rl:known-hosts-scan",
  budget: () => cockpitContextRateBudget("knownHostScan"),
  failClosed: true,
  overBudgetMessage: (seconds) => `Too many host scans. Try again in ${seconds}s.`,
  unavailableMessage: "Host scanning is temporarily unavailable. Try again in a moment.",
  unavailableLog: "[known-hosts] scan budget unavailable, failing closed:",
});

const hostSchema = z.string().trim().min(1).max(253);
const portSchema = z.number().int().min(1).max(65_535).default(22);

function serializeHost(host: KnownHostView) {
  return {
    id: host.id,
    host: host.host,
    port: host.port,
    keyType: host.keyType,
    publicKey: host.publicKey,
    fingerprint: host.fingerprint,
    createdAt: host.createdAt,
  };
}

/**
 * The built-in host keys, for the Known hosts screen to show read-only. They
 * are public (each provider publishes them) and fixed in code, so this reads
 * no database and is the same for every user.
 */
const pinnedHosts = Object.entries(PINNED_HOST_KEYS).map(([host, keys]) => ({
  host,
  port: 22,
  keys: keys.map((key) => ({ keyType: key.keyType, fingerprint: key.fingerprint })),
}));

export const knownHostsRouter = {
  pinned: protectedProcedure.handler(() => ({ items: pinnedHosts })),

  list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.knownHost.findMany({
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      select: knownHostSelect,
    });
    const page = cursorPage(rows, input.limit, "createdAt");
    return { items: page.items.map(serializeHost), nextCursor: page.nextCursor };
  }),

  scan: protectedProcedure
    .input(z.object({ host: hostSchema, port: portSchema }))
    .handler(async ({ input, context }) => {
      await consumeScanBudget(`user:${context.session.user.id}`);
      const scan = await withDomainErrors(() =>
        scanKnownHost({ host: input.host, port: input.port }),
      );
      return {
        host: scan.host,
        port: scan.port,
        pinned: scan.pinned,
        keys: scan.keys.map((key) => ({
          keyType: key.keyType,
          publicKey: key.publicKey,
          fingerprint: key.fingerprint,
        })),
      };
    }),

  confirm: protectedProcedure
    .input(
      z.object({
        host: hostSchema,
        port: portSchema,
        keyType: z.string().trim().min(1).max(64),
        publicKey: z.string().trim().min(1).max(16_384),
      }),
    )
    .handler(async ({ input, context }) => {
      const host = await withDomainErrors(() =>
        confirmKnownHost({
          ownerId: context.session.user.id,
          host: input.host,
          port: input.port,
          keyType: input.keyType,
          publicKey: input.publicKey,
        }),
      );
      return serializeHost(host);
    }),

  delete: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      await withDomainErrors(() =>
        deleteKnownHost({ ownerId: context.session.user.id, id: input.id }),
      );
      return { ok: true as const };
    }),
};
