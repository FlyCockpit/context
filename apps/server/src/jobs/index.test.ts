import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  backupsEnabled: true,
  env: { JOBS_CONCURRENCY: 3, COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: 90 },
  runner: {
    start: vi.fn(),
    stop: vi.fn(),
    health: vi.fn(() => "running"),
  },
  createJobRunner: vi.fn(),
  startPeriodicJob: vi.fn(),
  scheduleStops: [] as Array<ReturnType<typeof vi.fn>>,
  sweepTmpDir: vi.fn(),
  recoverInterruptedGitWork: vi.fn(),
  engine: {
    recover: vi.fn(async () => 0),
    shutdown: vi.fn(async () => true),
  },
  summaryFailureListeners: new Set<
    (failure: { runId: string; checkoutId: string; error: string }) => unknown
  >(),
  sendJobFailureAlert: vi.fn(async () => {}),
  sendSummaryRunFailureAlert: vi.fn(async () => {}),
}));

vi.mock("@cockpit-context/env/server", () => ({ env: state.env }));
vi.mock("@cockpit-context/env/shared", () => ({ env: {} }));
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/db/data-deletion-notices", () => ({
  listUnnotifiedDataDeletions: vi.fn(),
  markDataDeletionNotified: vi.fn(),
}));
vi.mock("@cockpit-context/mailer", () => ({
  escapeHtml: (value: string) => value,
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
}));
vi.mock("@cockpit-context/api/lib/backup-freshness", () => ({
  backupFreshnessEnabled: () => state.backupsEnabled,
  backupFreshnessNeedsAttention: vi.fn(),
  checkBackupFreshness: vi.fn(),
  writeBackupFreshness: vi.fn(),
}));
vi.mock("@cockpit-context/repos", () => ({
  sweepTmpDir: state.sweepTmpDir,
  recoverInterruptedGitWork: state.recoverInterruptedGitWork,
  fetchRepository: vi.fn(),
  pruneStorage: vi.fn(),
  isRepoError: () => false,
}));
vi.mock("@cockpit-context/runs", () => ({
  getRunEngine: () => state.engine,
  onSummaryFailure: (
    listener: (failure: { runId: string; checkoutId: string; error: string }) => unknown,
  ) => {
    state.summaryFailureListeners.add(listener);
    return () => {
      state.summaryFailureListeners.delete(listener);
    };
  },
}));
vi.mock("./operational-alerts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operational-alerts.js")>()),
  sendJobFailureAlert: state.sendJobFailureAlert,
  sendSummaryRunFailureAlert: state.sendSummaryRunFailureAlert,
}));
vi.mock("@cockpit-context/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-context/jobs")>();
  return {
    ...actual,
    createJobRunner: state.createJobRunner,
    startPeriodicJob: state.startPeriodicJob,
  };
});

const { SERVER_JOBS, startBackgroundJobs } = await import("./index.js");

describe("startBackgroundJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.backupsEnabled = true;
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 90;
    state.scheduleStops = [];
    state.summaryFailureListeners.clear();
    state.createJobRunner.mockReturnValue(state.runner);
    state.runner.start.mockResolvedValue(undefined);
    state.runner.stop.mockResolvedValue(true);
    state.sweepTmpDir.mockResolvedValue(0);
    state.recoverInterruptedGitWork.mockResolvedValue({
      repositories: 0,
      stagingDirs: 0,
      checkouts: 0,
    });
    state.startPeriodicJob.mockImplementation(() => {
      const stop = vi.fn();
      state.scheduleStops.push(stop);
      return stop;
    });
  });

  it("registers every server job type exactly once", () => {
    const types = SERVER_JOBS.map((job) => job.definition.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toEqual(
      expect.arrayContaining([
        "jobs.prune",
        "auth.reap-expired-tokens",
        "backup.check-freshness",
        "repository.fetch",
        "storage.prune",
        "checkout.summarize",
        "conversations.retention",
      ]),
    );
    // The engine clones and creates checkouts inline; those job types are gone.
    expect(types).not.toContain("repository.clone");
    expect(types).not.toContain("checkout.create");
  });

  it("starts the runner with the configured concurrency before any schedule", async () => {
    const order: string[] = [];
    state.runner.start.mockImplementation(async () => {
      order.push("runner");
    });
    state.startPeriodicJob.mockImplementation(() => {
      order.push("schedule");
      return vi.fn();
    });
    await startBackgroundJobs();
    expect(state.createJobRunner).toHaveBeenCalledWith(
      expect.objectContaining({ jobs: SERVER_JOBS, concurrency: 3 }),
    );
    expect(order[0]).toBe("runner");
    const scheduled = state.startPeriodicJob.mock.calls.map((call) => call[0].definition.type);
    expect(scheduled).toEqual([
      "database.notify-data-deletions",
      "jobs.prune",
      "storage.prune",
      "auth.reap-expired-tokens",
      "oauth.cleanup",
      "conversations.retention",
      "backup.check-freshness",
    ]);
  });

  it("schedules deletion notices every 15 minutes and registers the handler", async () => {
    await startBackgroundJobs();
    expect(
      SERVER_JOBS.some((job) => job.definition.type === "database.notify-data-deletions"),
    ).toBe(true);
    expect(state.startPeriodicJob).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({ type: "database.notify-data-deletions" }),
        payload: { reason: "schedule" },
        everyMs: 15 * 60_000,
      }),
    );
  });

  it("sweeps leftover git temp files before the runner starts", async () => {
    const order: string[] = [];
    state.sweepTmpDir.mockImplementation(async () => {
      order.push("sweep");
      return 0;
    });
    state.runner.start.mockImplementation(async () => {
      order.push("runner");
    });
    await startBackgroundJobs();
    expect(order).toEqual(["sweep", "runner"]);
  });

  it("still starts when the sweep fails", async () => {
    state.sweepTmpDir.mockRejectedValue(new Error("EACCES"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startBackgroundJobs();
    expect(state.runner.start).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not schedule the backup check when backups are off", async () => {
    state.backupsEnabled = false;
    await startBackgroundJobs();
    const scheduled = state.startPeriodicJob.mock.calls.map((call) => call[0].definition.type);
    expect(scheduled).not.toContain("backup.check-freshness");
  });

  it("does not schedule conversation retention when it is 0 (keep until deleted)", async () => {
    state.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS = 0;
    await startBackgroundJobs();
    const scheduled = state.startPeriodicJob.mock.calls.map((call) => call[0].definition.type);
    expect(scheduled).not.toContain("conversations.retention");
  });

  it("schedules conversation retention daily", async () => {
    await startBackgroundJobs();
    const retention = state.startPeriodicJob.mock.calls.find(
      (call) => call[0].definition.type === "conversations.retention",
    );
    expect(retention?.[0]).toMatchObject({
      payload: { reason: "schedule" },
      everyMs: 24 * 60 * 60 * 1000,
    });
  });

  it("stops every schedule, then drains the runner", async () => {
    const jobs = await startBackgroundJobs();
    await expect(jobs.stop()).resolves.toBe(true);
    for (const stop of state.scheduleStops) expect(stop).toHaveBeenCalledOnce();
    expect(state.runner.stop).toHaveBeenCalledOnce();
    expect(jobs.health()).toBe("running");
  });

  it("recovers orphaned runs before the runner starts", async () => {
    const order: string[] = [];
    state.engine.recover.mockImplementation(async () => {
      order.push("recover");
      return 2;
    });
    state.runner.start.mockImplementation(async () => {
      order.push("runner");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await startBackgroundJobs();
    expect(order).toEqual(["recover", "runner"]);
    log.mockRestore();
  });

  it("recovers interrupted clones and checkouts after run recovery, before the runner starts", async () => {
    const order: string[] = [];
    state.sweepTmpDir.mockImplementation(async () => {
      order.push("sweep");
      return 0;
    });
    state.engine.recover.mockImplementation(async () => {
      order.push("runs");
      return 0;
    });
    state.recoverInterruptedGitWork.mockImplementation(async () => {
      order.push("git");
      return { repositories: 1, stagingDirs: 1, checkouts: 2 };
    });
    state.runner.start.mockImplementation(async () => {
      order.push("runner");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await startBackgroundJobs();
      expect(order).toEqual(["sweep", "runs", "git", "runner"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("1 clone(s)"));
    } finally {
      log.mockRestore();
    }
  });

  it("still starts when git recovery fails", async () => {
    state.recoverInterruptedGitWork.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await startBackgroundJobs();
      expect(state.runner.start).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("interrupts live runs before draining the runner on stop", async () => {
    const order: string[] = [];
    state.engine.shutdown.mockImplementation(async () => {
      order.push("runs");
      return true;
    });
    state.runner.stop.mockImplementation(async () => {
      order.push("runner");
      return true;
    });
    const jobs = await startBackgroundJobs();
    await jobs.stop();
    expect(order).toEqual(["runs", "runner"]);
  });

  it("alerts admins about a failed summary run under the checkout.summarize label", async () => {
    const jobs = await startBackgroundJobs();
    expect(state.summaryFailureListeners.size).toBe(1);
    for (const listener of state.summaryFailureListeners) {
      await listener({ runId: "run-1", checkoutId: "k1", error: "model down" });
    }
    expect(state.createJobRunner).toHaveBeenCalledWith(
      expect.objectContaining({ onTerminalFailure: state.sendJobFailureAlert }),
    );
    expect(state.sendSummaryRunFailureAlert).toHaveBeenCalledWith({
      jobType: "checkout.summarize",
      runId: "run-1",
      checkoutId: "k1",
      error: "model down",
    });
    // Not a job failure: the job row succeeded.
    expect(state.sendJobFailureAlert).not.toHaveBeenCalled();
    await jobs.stop();
    expect(state.summaryFailureListeners.size).toBe(0);
  });

  it("schedules the hourly measuring prune", async () => {
    await startBackgroundJobs();
    const prune = state.startPeriodicJob.mock.calls.find(
      (call) => call[0].definition.type === "storage.prune",
    )?.[0];
    expect(prune).toMatchObject({
      payload: { reason: "schedule", measure: true },
      everyMs: 3_600_000,
    });
  });
});
