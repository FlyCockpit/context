import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/server", () => ({
  env: {
    OPENROUTER_API_KEY: "or-key",
    COCKPIT_CONTEXT_MODEL: "vendor/main",
    COCKPIT_CONTEXT_MODEL_API: "messages",
    COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "http://localhost:4010/api/v1",
    COCKPIT_CONTEXT_MAX_ITERATIONS: 100,
    COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS: 600,
    COCKPIT_CONTEXT_MODEL_STALL_SECONDS: 90,
    COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS: 4,
    COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER: 3,
    COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER: 20,
    JOBS_CONCURRENCY: 2,
    COCKPIT_CONTEXT_LSP_MAX_SERVERS: 4,
    COCKPIT_CONTEXT_LSP_IDLE_SECONDS: 30,
    COCKPIT_CONTEXT_LSP_SANDBOX: "required",
  },
  COCKPIT_CONTEXT_HELPER_MODEL: "vendor/main",
}));

const { loadRunConfig } = await import("./config");

describe("loadRunConfig", () => {
  it("maps the COCKPIT_CONTEXT_* and OpenRouter variables onto the engine config", () => {
    expect(loadRunConfig()).toEqual({
      apiKey: "or-key",
      model: "vendor/main",
      helperModel: "vendor/main",
      modelApi: "messages",
      baseUrl: "http://localhost:4010/api/v1",
      maxIterations: 100,
      runTimeoutMs: 600_000,
      modelStallTimeoutMs: 90_000,
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerUser: 3,
      maxQueuedRunsPerUser: 20,
      maxConcurrentSummaries: 2,
      lspMaxServers: 4,
      lspIdleMs: 30_000,
      lspSandbox: "required",
    });
  });
});
