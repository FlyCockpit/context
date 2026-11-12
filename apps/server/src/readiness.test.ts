import { describe, expect, it } from "vitest";
import { readinessResponse, shutdownReadinessResponse, withReadinessCommit } from "./readiness";

describe("readinessResponse", () => {
  it("is ready when Postgres answers and the runner is running", () => {
    expect(readinessResponse({ postgres: true, jobs: "running", commit: null })).toEqual({
      status: 200,
      body: {
        ok: true,
        commit: null,
        degraded: false,
        checks: { postgres: true, jobs: "running" },
      },
    });
  });

  it("stays ready but degraded when the job runner is failing", () => {
    const result = readinessResponse({ postgres: true, jobs: "failing", commit: null });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, degraded: true });
  });

  it("is not ready without Postgres, whatever the runner says", () => {
    const result = readinessResponse({ postgres: false, jobs: "running", commit: null });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, degraded: false });
  });
});

describe("build commit readiness", () => {
  it.each([true, false])("reports the build SHA with Postgres=%s", (postgres) => {
    const commit = "a".repeat(40);
    expect(readinessResponse({ postgres, jobs: "running", commit }).body.commit).toBe(commit);
  });
  it.each([null, "b".repeat(40)])("keeps shutdown coarse and reports commit %s", (commit) => {
    expect(shutdownReadinessResponse(commit)).toEqual({
      status: 503,
      body: { ok: false, commit, checks: { shuttingDown: true } },
    });
  });
});

describe("withReadinessCommit", () => {
  it.each([429, 503])(
    "keeps limiter status %s, redacted error, and retry headers",
    async (status) => {
      const error = "Too many attempts. Please wait a moment and try again.";
      const response = new Response(JSON.stringify({ error }), {
        status,
        headers: {
          "Retry-After": "5",
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "60",
        },
      });
      const result = await withReadinessCommit(response, "c".repeat(40));
      expect(result.status).toBe(status);
      expect(result.headers.get("Retry-After")).toBe("5");
      expect(result.headers.get("X-RateLimit-Limit")).toBe("60");
      expect(await result.json()).toEqual({ error, commit: "c".repeat(40) });
    },
  );
});
