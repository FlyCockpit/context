import prisma, { type Prisma } from "@cockpit-context/db";
import { RESET_PASSWORD_IDENTIFIER_PREFIX } from "./invite-verification.js";
import { withLockSlot } from "./lock-slots.js";

/** The ONE setup lock: password-write -> user credential/revocation -> set-password-link. */
function lockCredentialSetup(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  userId: string,
): Prisma.PrismaPromise<number> {
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`set-password-link:${userId}`}))`;
}

/** Short setup work only; never hold this transaction during SMTP delivery. */
export function withCredentialSetupLock<T>(
  userId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withLockSlot(() =>
    prisma.$transaction(async (tx) => {
      await lockCredentialSetup(tx, userId);
      return run(tx);
    }),
  );
}

/** Run deletion on the SAME transaction that holds the setup lock. */
export function deleteResetLinks(
  db: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
) {
  return db.verification.deleteMany({
    where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
}
