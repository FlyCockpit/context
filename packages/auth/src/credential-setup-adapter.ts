import prisma, { type Prisma } from "@cockpit-context/db";
import { BASE_ERROR_CODES, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { announceUserSessionsRevoked } from "./ban.js";
import { revokeCredentialsAfterPasswordReset } from "./credential-revocation.js";
import { withLockSlot } from "./lock-slots.js";
import { lockUserCredentials } from "./oauth-revocation.js";
import {
  admitResetSpend,
  deleteResetLinks,
  lockCredentialSetup,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
} from "./password-reset-links.js";
import {
  assertPasswordWriteLocked,
  isResetPasswordWrite,
  passwordWriteLockKey,
} from "./password-write-lock.js";
import { clearPendingInvitePassword } from "./sso-invite-activation.js";

type Adapter = ReturnType<ReturnType<typeof prismaAdapter>>;

/** One client, one acyclic order. No separate/nested lock connection. */
async function lockActivation(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passwordWriteLockKey(userId)}))`;
  await lockUserCredentials(tx, userId);
  await lockCredentialSetup(tx, userId);
}

/**
 * Global transactions stay OFF. Only the reset's existing adapter transaction
 * is real. Verification writes and IdP inserts use short local transactions;
 * signup locale reads, SMTP and callback network work never sit inside one.
 */
export function createCredentialSetupAdapter(
  { emailConfigured }: { emailConfigured: boolean },
  database: typeof prisma = prisma,
) {
  return (options: BetterAuthOptions): Adapter => {
    const make = (client: typeof prisma | Prisma.TransactionClient) =>
      prismaAdapter(client, { provider: "postgresql" })(options);
    const bind = (inner: Adapter, tx?: Prisma.TransactionClient): Adapter => {
      const verificationWrite = async <T>(
        args: Parameters<Adapter["update"]>[0],
        write: (adapter: Adapter) => Promise<T>,
      ): Promise<T> => {
        // /verify-email uses updateUserByEmail; IdP activation uses id.
        // Email is immutable. Require scalar, case-sensitive equality before
        // lookup, locks or writes: one selector must identify exactly one user.
        if (
          args.where.length !== 1 ||
          !["id", "email"].includes(args.where[0]!.field) ||
          (args.where[0]!.operator && args.where[0]!.operator !== "eq") ||
          args.where[0]!.mode === "insensitive" ||
          typeof args.where[0]!.value !== "string"
        ) {
          throw new Error("Activation requires an exact user selector");
        }
        const target = await inner.findOne<{ id: string }>({ model: "user", where: args.where });
        if (!target) return write(inner);
        const userId = target.id;
        if (tx) {
          // Reset already holds password-write/credential; never reacquire them.
          await lockCredentialSetup(tx, userId);
          const result = await write(inner);
          await deleteResetLinks(tx, userId);
          return result;
        }
        return withLockSlot(() =>
          database.$transaction(async (client) => {
            await lockActivation(client, userId);
            const result = await write(make(client));
            await deleteResetLinks(client, userId);
            return result;
          }),
        );
      };
      return {
        ...inner,
        // BA consults this AFTER transaction failure to decide whether queued
        // hooks must run for writes that could not roll back. Advertise the
        // selective reset truth per request, without mutating shared options.
        options: inner.options && {
          ...inner.options,
          adapterConfig: {
            ...inner.options.adapterConfig,
            get transaction() {
              return isResetPasswordWrite() ? inner.transaction : false;
            },
          },
        },
        transaction: async (callback) => {
          if (tx || !isResetPasswordWrite()) return callback(bind(inner, tx));
          // The outer password-write holder reserved this nested slot before
          // opening its lock connection. Hooks flush after this returns/releases.
          return withLockSlot(() =>
            database.$transaction(async (client) => {
              return callback(bind(make(client), client));
            }),
          );
        },
        consumeOne: async (args) => {
          if (args.model.toLowerCase() !== "verification") return inner.consumeOne(args);
          const row = await inner.findOne<{ identifier: string; value: string }>({ ...args });
          if (row?.identifier.startsWith(RESET_PASSWORD_IDENTIFIER_PREFIX)) {
            if (!tx || !isResetPasswordWrite())
              throw new Error("Reset consumption requires its password transaction");
            assertPasswordWriteLocked();
            await lockUserCredentials(tx, row.value);
            if (
              !(await admitResetSpend(
                tx,
                row.identifier.slice(RESET_PASSWORD_IDENTIFIER_PREFIX.length),
                { emailConfigured },
              ))
            ) {
              throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_TOKEN);
            }
          }
          return inner.consumeOne(args);
        },
        update: async <T>(args: Parameters<Adapter["update"]>[0]): Promise<T | null> => {
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.update<T>(args);
          return verificationWrite(args, (writer) => writer.update<T>(args));
        },
        updateMany: async (args) => {
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.updateMany(args);
          return verificationWrite(args, (writer) => writer.updateMany(args));
        },
        create: async <T extends Record<string, unknown>, R = T>(args: {
          model: string;
          data: Omit<T, "id">;
          select?: string[];
          forceAllowId?: boolean;
        }): Promise<R> => {
          if (args.model.toLowerCase() !== "account" || args.data.providerId === "credential")
            return inner.create<T, R>(args);
          if (tx) throw new Error("IdP linking cannot nest inside a reset transaction");
          const userId = args.data.userId;
          if (typeof userId !== "string") throw new Error("IdP link requires a user id");
          const { result, pending } = await withLockSlot(() =>
            database.$transaction(async (client) => {
              await lockActivation(client, userId);
              // Capture before account insertion or a subsequent verifying user write.
              const pending = await clearPendingInvitePassword(client, userId);
              const result = await make(client).create<T, R>(args);
              await deleteResetLinks(client, userId);
              return { result, pending };
            }),
          );
          // Credential fingerprints now see null. Sweep rows inserted while the
          // clearing transaction was uncommitted, before BA mints the IdP session.
          if (pending) {
            try {
              await revokeCredentialsAfterPasswordReset(userId);
            } finally {
              announceUserSessionsRevoked(userId);
            }
          }
          return result;
        },
      };
    };
    return bind(make(database));
  };
}
