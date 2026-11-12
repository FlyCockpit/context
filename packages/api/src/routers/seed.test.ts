import type { Session } from "@cockpit-context/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — handlers read env.NODE_ENV at call time, so flipping this
// between tests exercises the dev vs production confirm-phrase branches.
const envMock = { NODE_ENV: "development" as "development" | "production" | "test" };
vi.mock("@cockpit-context/env/server", () => ({
  env: envMock,
}));

// The seed itself is the author's code; the router only gates and times it.
const runSeed = vi.fn();
vi.mock("@cockpit-context/db/seed", () => ({ runSeed }));

// `../index` imports the Prisma client at module load (the force-2FA gate in
// adminOr404Procedure reads appSetting), so the db boundary must be mocked or
// @cockpit-context/db's createEnv() chain throws "Invalid environment variables" in CI
// (no DATABASE_URL). The mock defaults appSetting.findMany to [] so
// the role-scoped 2FA policy resolves false and leaves these confirm-phrase tests unaffected.
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

const { seedRouter, requiredConfirmPhrase } = await import("./seed");

function buildContext(role: "admin" | "user" | null): Context {
  if (role === null) return { session: null };
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role,
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "test-session-id",
        userId: "admin-user-id",
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

describe("requiredConfirmPhrase", () => {
  it("is the loud phrase in production, the lighter one otherwise", () => {
    expect(requiredConfirmPhrase("production")).toBe("seed");
    expect(requiredConfirmPhrase("development")).toBe("seed");
    expect(requiredConfirmPhrase("test")).toBe("seed");
  });
});

describe("seedRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.NODE_ENV = "development";
  });

  describe("info", () => {
    it("reports the dev confirm phrase and isProduction=false", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: false,
        requiredConfirmPhrase: "seed",
      });
    });

    it("reports the production phrase and isProduction=true in prod", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: true,
        requiredConfirmPhrase: "seed",
      });
    });

    it("404s for non-admins (the surface must not be discoverable)", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.info()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });

  describe("run", () => {
    it("runs the seed inline and returns its summary when the phrase matches", async () => {
      runSeed.mockResolvedValue({ summary: ["Ensured demo package"] });
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      const result = await client.run({ confirm: "seed" });

      expect(result).toEqual({ summary: ["Ensured demo package"], durationMs: expect.any(Number) });
      expect(runSeed).toHaveBeenCalledOnce();
      expect(runSeed).toHaveBeenCalledWith({ ownerId: "admin-user-id" });
    });

    it("trims surrounding whitespace before comparing the phrase", async () => {
      runSeed.mockResolvedValue({ summary: [] });
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "  seed  " })).resolves.toMatchObject({ summary: [] });
    });

    it("rejects a wrong confirm phrase without running the seed", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "yes" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(runSeed).not.toHaveBeenCalled();
    });

    it("is a no-op in production for every confirmation", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      for (const confirm of ["seed", "SEED PRODUCTION", "anything"]) {
        await expect(client.run({ confirm })).resolves.toEqual({ summary: [], durationMs: 0 });
      }
      expect(runSeed).not.toHaveBeenCalled();
    });

    it("refuses a second run while one is in flight, and allows one after", async () => {
      let finish: () => void = () => {};
      runSeed.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ summary: [] });
          }),
      );
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      const first = client.run({ confirm: "seed" });
      await vi.waitFor(() => expect(runSeed).toHaveBeenCalledOnce());
      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      finish();
      await first;

      runSeed.mockResolvedValue({ summary: [] });
      await expect(client.run({ confirm: "seed" })).resolves.toMatchObject({ summary: [] });
    });

    it("releases the guard when the seed throws", async () => {
      runSeed.mockRejectedValueOnce(new Error("unique constraint"));
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      await expect(client.run({ confirm: "seed" })).rejects.toThrow();
      runSeed.mockResolvedValue({ summary: [] });
      await expect(client.run({ confirm: "seed" })).resolves.toMatchObject({ summary: [] });
    });

    it("404s for non-admins", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });
});
