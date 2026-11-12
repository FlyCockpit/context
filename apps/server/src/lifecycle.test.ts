import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  postgres: vi.fn(),
  heartbeat: vi.fn(),
  markReady: vi.fn(),
  stopHeartbeat: vi.fn(),
  disconnectDb: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  health: vi.fn(),
  events: [] as string[],
}));
vi.mock("@cockpit-context/db", () => ({
  default: { $queryRaw: state.postgres, $disconnect: state.disconnectDb },
}));
vi.mock("@cockpit-context/db/instance-heartbeat", () => ({
  startInstanceHeartbeat: state.heartbeat,
}));
vi.mock("./jobs/index.js", () => ({
  startBackgroundJobs: state.start,
}));
const listeners = new Map<string, (...args: unknown[]) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  listeners.clear();
  state.events.length = 0;
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  state.postgres.mockResolvedValue(1);
  state.heartbeat.mockImplementation(() => {
    state.events.push("heartbeat-started");
    return { markReady: state.markReady, stop: state.stopHeartbeat };
  });
  state.stopHeartbeat.mockImplementation(async () => {
    state.events.push("heartbeat-stopped");
  });
  state.health.mockReturnValue("running");
  state.stop.mockImplementation(async () => {
    state.events.push("jobs-drained");
    return true;
  });
  state.disconnectDb.mockImplementation(async () => {
    state.events.push("db-disconnect");
  });
  state.start.mockImplementation(async () => {
    expect(listeners.has("SIGTERM")).toBe(true);
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.has("unhandledRejection")).toBe(true);
    state.events.push("jobs-started");
    return { health: state.health, stop: state.stop };
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createServerLifecycle", () => {
  it("registers after DB admission and marks ready only when the listener calls back", async () => {
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    let ready: (() => void) | undefined;
    await lifecycle.start((onReady) => {
      ready = onReady;
      return { close: vi.fn((done: () => void) => done()) };
    });
    expect(state.postgres.mock.invocationCallOrder[0]).toBeLessThan(
      state.heartbeat.mock.invocationCallOrder[0]!,
    );
    expect(state.heartbeat).toHaveBeenCalledWith({ role: "server" });
    expect(state.markReady).not.toHaveBeenCalled();
    ready?.();
    expect(state.markReady).toHaveBeenCalledOnce();
    listeners.get("SIGTERM")?.();
    ready?.();
    expect(state.markReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
  });

  it("awaits in-flight heartbeat writes before disconnecting Prisma", async () => {
    let finish: (() => void) | undefined;
    state.stopHeartbeat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { createServerLifecycle } = await import("./lifecycle");
    await createServerLifecycle().start(() => ({ close: vi.fn((done: () => void) => done()) }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.stopHeartbeat).toHaveBeenCalledOnce();
    expect(state.disconnectDb).not.toHaveBeenCalled();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.disconnectDb).toHaveBeenCalledOnce();
  });

  it("startup failure also awaits heartbeat writes before disconnecting", async () => {
    let finish: (() => void) | undefined;
    state.stopHeartbeat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    state.start.mockRejectedValue(new Error("recovery failed"));
    const { createServerLifecycle } = await import("./lifecycle");
    const starting = createServerLifecycle().start(vi.fn());
    await vi.waitFor(() => expect(state.stopHeartbeat).toHaveBeenCalledOnce());
    expect(state.disconnectDb).not.toHaveBeenCalled();
    finish?.();
    await starting;
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("does not register a heartbeat when DB admission fails", async () => {
    state.postgres.mockRejectedValue(new Error("offline"));
    const { createServerLifecycle } = await import("./lifecycle");
    const starting = createServerLifecycle().start(vi.fn());
    await vi.advanceTimersByTimeAsync(8000);
    await starting;
    expect(state.heartbeat).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("owns signals, checks Postgres, starts jobs before listening, and rejects re-entry", async () => {
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => {
      state.events.push("listening");
      return { close: vi.fn(), closeIdleConnections: vi.fn() };
    });
    expect(lifecycle.jobsHealth()).toBe("stopped");
    await lifecycle.start(listen);
    expect(state.postgres).toHaveBeenCalled();
    expect(state.events).toEqual(["heartbeat-started", "jobs-started", "listening"]);
    expect(lifecycle.jobsHealth()).toBe("running");
    await expect(lifecycle.start(listen)).rejects.toThrow("already started");
  });

  it.each(["SIGTERM", "SIGINT", "unhandledRejection"])(
    "%s during job startup waits for the runner before shared teardown",
    async (event) => {
      let finish: (() => void) | undefined;
      state.start.mockImplementation(
        () =>
          new Promise((resolve) => {
            state.events.push("jobs-starting");
            finish = () => resolve({ health: state.health, stop: state.stop });
          }),
      );
      const { createServerLifecycle } = await import("./lifecycle");
      const lifecycle = createServerLifecycle();
      const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
      const starting = lifecycle.start(listen);
      await vi.waitFor(() => expect(state.events).toContain("jobs-starting"));
      listeners.get(event)?.(new Error("fatal"));
      expect(lifecycle.isShuttingDown()).toBe(true);
      expect(lifecycle.jobsHealth()).toBe("stopped");
      expect(state.disconnectDb).not.toHaveBeenCalled();
      finish?.();
      await starting;
      await vi.waitFor(() => expect(state.disconnectDb).toHaveBeenCalled());
      expect(listen).not.toHaveBeenCalled();
      expect(state.events.indexOf("jobs-drained")).toBeLessThan(
        state.events.indexOf("db-disconnect"),
      );
      expect(process.exit).toHaveBeenCalledWith(event.startsWith("SIG") ? 0 : 1);
      await expect(lifecycle.start(listen)).rejects.toThrow("already started");
    },
  );

  it("a failed job startup exits non-zero without listening", async () => {
    state.start.mockRejectedValue(new Error("recovery query failed"));
    const { createServerLifecycle } = await import("./lifecycle");
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    await createServerLifecycle().start(listen);
    expect(listen).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(state.stopHeartbeat).toHaveBeenCalledOnce();
    expect(state.events.indexOf("heartbeat-stopped")).toBeLessThan(
      state.events.indexOf("db-disconnect"),
    );
  });

  it("exits on an unclean job drain without closing the shared client", async () => {
    vi.useFakeTimers();
    state.stop.mockResolvedValue(false);
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    await lifecycle.start(() => ({
      close: vi.fn((done: () => void) => done()),
      closeIdleConnections: vi.fn(),
    }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.disconnectDb).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("bounds hung startup cancellation and refuses later listener admission", async () => {
    vi.useFakeTimers();
    state.start.mockImplementation(() => new Promise(() => {}));
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    void lifecycle.start(listen);
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(state.disconnectDb).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("drains HTTP and jobs, preserves a fatal exit arriving during a signal drain", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    state.stop.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        }),
    );
    const close = vi.fn((done: () => void) => {
      state.events.push("http-drained");
      done();
    });
    const closeIdleConnections = vi.fn(() => {
      state.events.push("idle-connections-closed");
    });
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    await lifecycle.start(() => ({ close, closeIdleConnections }));
    listeners.get("SIGTERM")?.();
    listeners.get("unhandledRejection")?.(new Error("fatal while draining"));
    expect(lifecycle.jobsHealth()).toBe("stopped");
    await vi.advanceTimersByTimeAsync(5000);
    expect(closeIdleConnections).toHaveBeenCalledOnce();
    expect(state.events.indexOf("idle-connections-closed")).toBeLessThan(
      state.events.indexOf("http-drained"),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(state.disconnectDb).not.toHaveBeenCalled();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("cancels pending dependency startup without starting jobs or listener", async () => {
    let finish: (() => void) | undefined;
    state.postgres.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    const starting = lifecycle.start(listen);
    listeners.get("SIGINT")?.();
    finish?.();
    await starting;
    expect(state.start).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("the real entrypoint wires lifecycle readiness into a Postgres-only /ready", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const lifecycle = createServerLifecycle()");
    expect(source).toContain("await lifecycle.start((onReady) =>");
    expect(source).toContain("onReady();");
    expect(source.match(/readBuildCommit\(\)/g)).toHaveLength(1);
    expect(source).toContain("shutdownReadinessResponse(buildCommit)");
    expect(source).toContain("lifecycle.isShuttingDown()");
    expect(source).toMatch(
      /readinessResponse\(\{\s*postgres,\s*jobs: lifecycle\.jobsHealth\(\),\s*commit: buildCommit,?\s*\}\)/,
    );
    expect(source).not.toMatch(/redis/i);
  });
});
