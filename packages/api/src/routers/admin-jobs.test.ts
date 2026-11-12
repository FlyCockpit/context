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
vi.mock("@cockpit-context/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/jobs")>()),
  retryFailedJob: vi.fn(),
}));

const { default: prisma } = await import("@cockpit-context/db");
const { retryFailedJob } = await import("@cockpit-context/jobs");
const { adminJobsRouter } = await import("./admin-jobs");

const db = prisma as unknown as { backgroundJob: { findMany: MockInstance } };
const retry = retryFailedJob as unknown as MockInstance;

const NOW = new Date("2026-10-01T00:00:00Z");

function client(context = adminContext()) {
  return createRouterClient(adminJobsRouter, { context });
}

describe("adminJobsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is 404-hidden from anonymous callers and regular users", async () => {
    for (const context of [anonymousContext, sessionContext({ id: "user-a" })]) {
      await expect(client(context).list({})).rejects.toSatisfy(
        (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
      );
      await expect(client(context).retry({ id: "job-1" })).rejects.toSatisfy(
        (error: ORPCError<string, unknown>) => error.code === "NOT_FOUND",
      );
    }
    expect(db.backgroundJob.findMany).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("lists jobs newest first without their payloads", async () => {
    db.backgroundJob.findMany.mockResolvedValue([
      {
        id: "job-1",
        createdAt: NOW,
        type: "repository.fetch",
        status: "failed",
        attempts: 3,
        maxAttempts: 3,
        runAt: NOW,
        lockedAt: null,
        finishedAt: NOW,
        lastError: "git exited 128",
        payload: { repositoryId: "repo-1" },
      },
    ]);
    const result = await client().list({ status: "failed" });
    const args = db.backgroundJob.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ AND: [{ status: "failed" }] });
    expect(args.select).not.toHaveProperty("payload");
    expect(result.items[0]).not.toHaveProperty("payload");
    expect(result.items[0]).toMatchObject({ type: "repository.fetch", status: "failed" });
  });

  it("retries a failed job and refuses anything else", async () => {
    retry.mockResolvedValue({ retried: true, type: "repository.fetch" });
    await expect(client().retry({ id: "job-1" })).resolves.toEqual({ ok: true });
    expect(retry).toHaveBeenCalledWith("job-1");
    retry.mockResolvedValue({ retried: false });
    await expect(client().retry({ id: "job-2" })).rejects.toSatisfy(
      (error: ORPCError<string, { reason: string }>) =>
        error.code === "CONFLICT" && error.data.reason === "JOB_NOT_FAILED",
    );
    retry.mockResolvedValue({ retried: false, missing: true });
    await expect(client().retry({ id: "job-gone" })).rejects.toSatisfy(
      (error: ORPCError<string, { reason: string }>) =>
        error.code === "NOT_FOUND" && error.data.reason === "JOB_NOT_FOUND",
    );
  });
});
