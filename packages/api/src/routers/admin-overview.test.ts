import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext, anonymousContext, sessionContext } from "../test-support/context";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@cockpit-context/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
vi.mock("@cockpit-context/repos", () => ({
  totalStorageBytes: vi.fn(async () => 5_000n),
  maxStorageBytes: vi.fn(() => 20_000_000_000n),
}));
vi.mock("@cockpit-context/auth/signup-availability", () => ({
  isSignupOpen: vi.fn(async () => false),
}));

const { default: prisma } = await import("@cockpit-context/db");
const repos = await import("@cockpit-context/repos");
const { isSignupOpen } = await import("@cockpit-context/auth/signup-availability");
const { adminOverviewRouter } = await import("./admin-overview");

const db = prisma as unknown as {
  user: { count: MockInstance; findMany: MockInstance };
  backgroundJob: { count: MockInstance; findMany: MockInstance };
};

function client(context = adminContext()) {
  return createRouterClient(adminOverviewRouter, { context });
}

describe("adminOverviewRouter.stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is 404-hidden from anonymous callers and regular users", async () => {
    for (const context of [anonymousContext, sessionContext({ id: "user-a" })]) {
      await expect(client(context).stats()).rejects.toSatisfy(
        (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
      );
    }
    expect(db.user.count).not.toHaveBeenCalled();
    expect(db.backgroundJob.count).not.toHaveBeenCalled();
    expect(repos.totalStorageBytes).not.toHaveBeenCalled();
    expect(isSignupOpen).not.toHaveBeenCalled();
  });

  it("returns one figure per card from counts and sums, never row lists", async () => {
    db.user.count.mockImplementation(async (args: { where: unknown }) =>
      JSON.stringify(args.where).includes('"banned":true') ? 2 : 7,
    );
    db.backgroundJob.count.mockResolvedValue(3);
    vi.mocked(isSignupOpen).mockResolvedValue(true);

    await expect(client().stats()).resolves.toEqual({
      users: { active: 7, archived: 2 },
      storage: { totalBytes: 5_000, capBytes: 20_000_000_000 },
      jobs: { failed: 3 },
      settings: { signupOpen: true },
    });

    // Same definitions as the Users page filters and the Jobs page `failed` filter.
    expect(db.user.count).toHaveBeenCalledWith({
      where: { OR: [{ banned: false }, { banned: null }] },
    });
    expect(db.user.count).toHaveBeenCalledWith({ where: { banned: true } });
    expect(db.backgroundJob.count).toHaveBeenCalledWith({ where: { status: "failed" } });
    // Bounded: aggregates only, no unbounded list reads.
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.backgroundJob.findMany).not.toHaveBeenCalled();
  });
});
