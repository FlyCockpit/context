import prisma from "@cockpit-context/db";
import {
  type InstanceHeartbeat,
  startInstanceHeartbeat,
} from "@cockpit-context/db/instance-heartbeat";
import type { JobRunnerHealth } from "@cockpit-context/jobs";
import { type BackgroundJobs, startBackgroundJobs } from "./jobs/index.js";

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The HTTP host owns signals before dependency startup or the first job.
 *
 * Startup: Postgres answers → the instance heartbeat starts → the in-process
 * job runner starts (it recovers orphaned `running` rows first) → the HTTP
 * listener opens and marks the instance ready. Shutdown: /ready
 * flips to 503 at once, the runner stops claiming and drains while HTTP drains,
 * and only then is the heartbeat stopped and the shared Prisma client disconnected.
 */
export function createServerLifecycle() {
  const startup = new AbortController();
  let jobs: BackgroundJobs | undefined;
  let heartbeat: InstanceHeartbeat | undefined;
  let starting: Promise<BackgroundJobs> | undefined;
  // closeIdleConnections exists on plain HTTP servers (Node >= 18.2); hono's
  // serve() return union also admits Http2 servers, which lack it — hence optional.
  let server:
    | { close(callback: (error?: Error) => void): unknown; closeIdleConnections?(): void }
    | undefined;
  let closing: Promise<void> | undefined;
  let claimed = false;
  let exitCode = 0;
  const shutdownHooks: Array<() => Promise<void> | void> = [];

  function requireRunning() {
    if (startup.signal.aborted) throw new Error("Server startup cancelled.");
  }
  async function waitForDependency(name: string, ping: () => Promise<unknown>) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      requireRunning();
      try {
        await withTimeout(ping(), 5000, `${name} startup ping`);
        requireRunning();
        console.log(`[server] ${name} is reachable.`);
        return;
      } catch (error) {
        requireRunning();
        if (attempt === 5) throw error;
        const delay = 500 * 2 ** (attempt - 1);
        console.warn(`[server] ${name} not ready (attempt ${attempt}/5), retrying in ${delay}ms.`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  function shutdown(reason: string, code = 0): Promise<void> {
    if (code) exitCode = code;
    if (closing) return closing;
    // Set the process watchdog before cancellation invokes any callbacks.
    const watchdog = setTimeout(() => process.exit(exitCode || 1), 25_000);
    startup.abort();
    console.log(`[server] Received ${reason} — starting graceful shutdown…`);
    closing = (async () => {
      // Hooks start at once and run alongside the drains below (MCP closes
      // its admission gate so long waits answer now instead of holding the
      // HTTP drain). A failing hook is logged, never fatal to the shutdown.
      const hooksDone = Promise.allSettled(
        shutdownHooks.map(async (hook) => {
          try {
            await hook();
          } catch (error) {
            console.error("[server] Shutdown hook failed:", error);
          }
        }),
      );
      const jobDrain = (async () => {
        let active = jobs;
        if (!active && starting) {
          // A startup that rejected never started the runner's claim loop.
          active = await starting.catch(() => undefined);
        }
        return (await active?.stop()) ?? true;
      })();
      // Handle rejection now while the independent HTTP drain is in progress.
      const jobResult = jobDrain.then(
        (drained) => {
          if (!drained) console.error("[server] Background jobs did not drain in time.");
          return drained;
        },
        (error: unknown) => {
          console.error("[server] Background job drain failed:", error);
          return false;
        },
      );
      if (server) {
        // /ready has already flipped to 503, allowing the proxy to stop routing.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        // close() also waits on idle keep-alive sockets; release them now so only
        // in-flight requests hold the drain.
        server.closeIdleConnections?.();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 10_000);
          server?.close((error) => {
            clearTimeout(timeout);
            if (error) console.error("[server] Error closing HTTP server:", error.message);
            resolve();
          });
        });
      }
      await withTimeout(hooksDone, 5000, "shutdown hooks").catch(() => {
        console.error("[server] Shutdown hooks did not finish in time.");
      });
      if (!(await jobResult)) {
        // An aborted job may still hold the shared client; never disconnect
        // under it. Its row stays `running` and is recovered on the next boot.
        process.exit(1);
        return;
      }
      await heartbeat?.stop();
      await prisma.$disconnect();
      clearTimeout(watchdog);
      process.exit(exitCode);
    })().catch((error: unknown) => {
      console.error("[server] Shutdown failed:", error);
      process.exit(1);
    });
    return closing;
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (error) => {
    console.error("[server] unhandledRejection", error);
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    // An unwound stack may leave shared state inconsistent; don't run a drain.
    console.error("[server] uncaughtException", error);
    process.exit(1);
  });
  return {
    isShuttingDown: () => startup.signal.aborted,
    /** Run `hook` when shutdown begins (before the HTTP drain), at most 5 s. */
    onShutdown(hook: () => Promise<void> | void) {
      shutdownHooks.push(hook);
    },
    /** The job runner's coarse health; `stopped` before start and after shutdown begins. */
    jobsHealth: (): JobRunnerHealth =>
      startup.signal.aborted ? "stopped" : (jobs?.health() ?? "stopped"),
    async start(listen: (onReady: () => void) => NonNullable<typeof server>) {
      if (claimed) throw new Error("Server already started; restart the process to re-enter.");
      claimed = true;
      try {
        await waitForDependency("Postgres", () => prisma.$queryRaw`SELECT 1`);
        requireRunning();
        heartbeat = startInstanceHeartbeat({ role: "server" });
        starting = startBackgroundJobs();
        jobs = await starting;
        requireRunning();
        server = listen(() => {
          if (!startup.signal.aborted) heartbeat?.markReady();
        });
      } catch (error) {
        console.error("[server] Startup failed:", error);
        await shutdown("startup failure", startup.signal.aborted ? 0 : 1);
      }
    },
  };
}
