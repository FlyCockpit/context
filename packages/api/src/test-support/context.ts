import type { Session } from "@cockpit-context/auth";

import type { Context } from "../context";

/**
 * oRPC contexts for router tests (docs/development.md).
 * Test-only: imported by `*.test.ts` files, never by production code.
 *
 * Admins are 2FA-enrolled because forced admin 2FA is the shipped default
 * (`FORCE_2FA_DEFAULTS`), so an unenrolled admin would be refused before the
 * router ran.
 */
export function sessionContext(
  user: Partial<Session["user"]> & { id: string } = { id: "user-a" },
): Context {
  const role = user.role ?? "user";
  return {
    clientIp: "127.0.0.1",
    session: {
      user: {
        email: `${user.id}@example.com`,
        name: user.id,
        emailVerified: true,
        role,
        twoFactorEnabled: role === "admin",
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...user,
      },
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    } as Session,
  };
}

export const anonymousContext: Context = { session: null, clientIp: "127.0.0.1" };

export function adminContext(id = "admin-1"): Context {
  return sessionContext({ id, role: "admin" });
}
