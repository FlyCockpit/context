import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

import type prismaClient from "../src/index";

const envMock = {
  NODE_ENV: "development" as "development" | "production" | "test",
  BETTER_AUTH_SECRET: "s".repeat(32),
};
vi.mock("@cockpit-context/env/server", () => ({ env: envMock }));

const db = mockDeep<typeof prismaClient>();
vi.mock("../src/index", () => ({ default: db }));

const seedDemoData = vi.fn();
vi.mock("./seed-demo", () => ({ seedDemoData }));

const { runSeed } = await import("./seed");

describe("runSeed", () => {
  beforeEach(() => {
    mockReset(db);
    seedDemoData.mockReset();
    seedDemoData.mockResolvedValue(["demo line"]);
    envMock.NODE_ENV = "development";
  });

  it("seeds nothing in production", async () => {
    envMock.NODE_ENV = "production";
    const result = await runSeed({ ownerId: "admin" });
    expect(seedDemoData).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(result.summary.join(" ")).toMatch(/development-only/);
  });

  it("seeds for the given owner id", async () => {
    db.user.findUnique.mockResolvedValue({ id: "admin", email: "a@example.com" } as never);
    const result = await runSeed({ ownerId: "admin" });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "admin" } }),
    );
    expect(seedDemoData).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "admin", betterAuthSecret: envMock.BETTER_AUTH_SECRET }),
    );
    expect(result.summary).toEqual(["Seeding demo data for a@example.com", "demo line"]);
  });

  it("seeds for the owner named by email", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u2", email: "b@example.com" } as never);
    await runSeed({ ownerEmail: "b@example.com" });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "b@example.com" } }),
    );
    expect(seedDemoData).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "u2" }));
  });

  it("defaults to the first admin, then the first user", async () => {
    db.user.findFirst.mockResolvedValueOnce(null);
    db.user.findFirst.mockResolvedValueOnce({ id: "first", email: "f@example.com" } as never);
    await runSeed();
    expect(db.user.findFirst).toHaveBeenCalledTimes(2);
    expect(seedDemoData).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "first" }));
  });

  it("says so when there is nobody to seed for", async () => {
    db.user.findFirst.mockResolvedValue(null);
    const result = await runSeed();
    expect(seedDemoData).not.toHaveBeenCalled();
    expect(result.summary).toEqual(["No users yet: sign up first, then run the seed again."]);
  });
});
