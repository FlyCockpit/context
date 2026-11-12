import type { JobRunnerHealth } from "@cockpit-context/jobs";

/** What the readiness probe (`GET /ready`, ./index.ts) observed. */
export type ReadinessObservation = {
  /** `SELECT 1` on the shared client answered within its bound. */
  postgres: boolean;
  /** Full build SHA, or null when build metadata is unavailable. */
  commit: string | null;
  /** The in-process background job runner's coarse health. */
  jobs: JobRunnerHealth;
};

/**
 * The readiness probe's answer. Only Postgres decides the status code (503
 * when it is unreachable): Postgres is the app's only external dependency, and
 * a failing background job is no reason for a proxy or deploy gate to route
 * traffic away. The job runner's health is reported alongside, so an operator
 * (or monitoring that reads the body) sees a stalled runner without reading
 * logs; `degraded` is true when Postgres is up but the runner is not running.
 * The probe is unauthenticated, so it carries coarse states only: no counts,
 * timestamps or error details.
 */
export function readinessResponse(observed: ReadinessObservation): {
  status: 200 | 503;
  body: {
    ok: boolean;
    commit: string | null;
    degraded: boolean;
    checks: { postgres: boolean; jobs: JobRunnerHealth };
  };
} {
  return {
    status: observed.postgres ? 200 : 503,
    body: {
      ok: observed.postgres,
      commit: observed.commit,
      degraded: observed.postgres && observed.jobs !== "running",
      checks: { postgres: observed.postgres, jobs: observed.jobs },
    },
  };
}

/** Preserve the coarse shutdown answer without probing dependencies. */
export function shutdownReadinessResponse(commit: string | null) {
  return {
    status: 503 as const,
    body: { ok: false, commit, checks: { shuttingDown: true } },
  };
}

/** Add release identity to limiter rejections without changing their error or headers. */
export async function withReadinessCommit(
  response: Response,
  commit: string | null,
): Promise<Response> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Readiness limiter returned an invalid response.");
  }
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(JSON.stringify({ ...body, commit }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
