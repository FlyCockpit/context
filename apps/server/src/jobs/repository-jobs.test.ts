import { beforeEach, describe, expect, it, vi } from "vitest";

// @cockpit-context/jobs' store imports the Prisma client (env-validated at load).
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const repos = vi.hoisted(() => ({
  fetchRepository: vi.fn(),
  pruneStorage: vi.fn(),
}));
vi.mock("@cockpit-context/repos", async () => {
  const { RepoError, isRepoError } = await import("@cockpit-context/repos/errors");
  return { ...repos, RepoError, isRepoError };
});

const { PermanentJobError } = await import("@cockpit-context/jobs");
const { RepoError } = await import("@cockpit-context/repos/errors");
const { fetchRepositoryJob, pruneStorageJob } = await import("@cockpit-context/repos/jobs");
const { fetchRepositoryHandler, pruneStorageHandler } = await import("./repository-jobs.js");

function context<T>(type: string, payload: T) {
  return {
    id: "j1",
    type,
    payload,
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
  };
}

describe("repository job definitions", () => {
  it("have stable types and strict payloads", () => {
    expect(fetchRepositoryJob.type).toBe("repository.fetch");
    expect(fetchRepositoryJob.payload.parse({ repositoryId: "r1" })).toEqual({
      repositoryId: "r1",
      mode: "default",
    });
    expect(
      fetchRepositoryJob.payload.safeParse({ repositoryId: "r1", mode: "everything" }).success,
    ).toBe(false);
    expect(pruneStorageJob.type).toBe("storage.prune");
    expect(pruneStorageJob.payload.parse({ reason: "schedule" })).toEqual({
      reason: "schedule",
      measure: false,
    });
  });
});

describe("repository job handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repos.pruneStorage.mockResolvedValue({
      beforeBytes: 10n,
      afterBytes: 10n,
      evictedCheckouts: [],
      evictedRepositories: [],
    });
  });

  it("fetch calls the service with the job's abort signal", async () => {
    const fetch = context("repository.fetch", { repositoryId: "r1", mode: "tags" as const });
    await fetchRepositoryHandler.handler(fetch);
    expect(repos.fetchRepository).toHaveBeenCalledWith("r1", {
      mode: "tags",
      signal: fetch.signal,
    });
  });

  it("prunes storage, measuring first when asked", async () => {
    const prune = context("storage.prune", { reason: "schedule" as const, measure: true });
    await pruneStorageHandler.handler(prune);
    expect(repos.pruneStorage).toHaveBeenCalledWith({ measure: true, signal: prune.signal });
  });

  it("turns errors a retry cannot fix into PermanentJobError", async () => {
    repos.fetchRepository.mockRejectedValue(
      new RepoError("HOST_KEY_UNCONFIRMED", "confirm the host key"),
    );
    await expect(
      fetchRepositoryHandler.handler(
        context("repository.fetch", { repositoryId: "r1", mode: "default" as const }),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("lets transient failures retry", async () => {
    repos.fetchRepository.mockRejectedValue(new RepoError("GIT_TIMEOUT", "timed out"));
    const failure = await fetchRepositoryHandler
      .handler(context("repository.fetch", { repositoryId: "r1", mode: "default" as const }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepoError);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
  });
});
