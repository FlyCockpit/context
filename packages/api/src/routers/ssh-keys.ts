import prisma from "@cockpit-context/db";
import {
  deleteSshKey,
  generateSshKey,
  importSshKey,
  type SshKeyView,
  sshKeyPublicSelect,
} from "@cockpit-context/repos";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { withDomainErrors } from "../lib/domain-errors";
import { lower } from "../lib/packages";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId, shortText } from "../lib/schemas";

/**
 * SSH keys for private repositories (docs/product.md). ⚠️ Dangerous row: the private half is AES-256-GCM
 * encrypted under COCKPIT_CONTEXT_ENCRYPTION_KEYS and NO procedure ever returns it. Every
 * read goes through `sshKeyPublicSelect`, which has no `keyVersion`, `nonce`,
 * `authTag` or `ciphertext`; `ssh-keys.test.ts` pins that.
 */

import { consumeKeyWriteBudget } from "../lib/ssh-key-input";

function serializeKey(key: SshKeyView) {
  return {
    id: key.id,
    name: key.name,
    source: lower(key.source),
    algorithm: key.algorithm,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
  };
}

export const sshKeysRouter = {
  list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.sshKey.findMany({
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      select: sshKeyPublicSelect,
    });
    const page = cursorPage(rows, input.limit, "createdAt");
    return { items: page.items.map(serializeKey), nextCursor: page.nextCursor };
  }),

  generate: protectedProcedure
    .input(z.object({ name: shortText }))
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      await consumeKeyWriteBudget(`user:${ownerId}`);
      const key = await withDomainErrors(() => generateSshKey({ ownerId, name: input.name }));
      return serializeKey(key);
    }),

  import: protectedProcedure
    .input(
      z.object({
        name: shortText,
        privateKey: z.string().min(1).max(16_384),
        // Keep the request bounded while letting the normalizer return the
        // specific SSH_KEY_PASSPHRASE_TOO_LONG reason above OpenSSH's byte limit.
        passphrase: z.string().max(4096).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const ownerId = context.session.user.id;
      await consumeKeyWriteBudget(`user:${ownerId}`);
      const key = await withDomainErrors(() =>
        importSshKey({
          ownerId,
          name: input.name,
          privateKey: input.privateKey,
          passphrase: input.passphrase,
        }),
      );
      return serializeKey(key);
    }),

  delete: protectedProcedure
    .input(z.object({ id: entityId }))
    .handler(async ({ input, context }) => {
      await withDomainErrors(() =>
        deleteSshKey({ ownerId: context.session.user.id, keyId: input.id }),
      );
      return { ok: true as const };
    }),
};
