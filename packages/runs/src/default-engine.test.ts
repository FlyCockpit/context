import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listeners: [] as Array<(ids: readonly string[]) => Promise<void>>,
  stopCheckout: vi.fn(async () => {}),
  enqueueJob: vi.fn(async () => ({ id: "job", created: true })),
  createRunEngine: vi.fn(),
  deps: undefined as unknown,
  lspOptions: undefined as unknown,
  probes: 0,
}));

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("./config", () => ({
  loadRunConfig: () => ({ lspMaxServers: 2, lspIdleMs: 5_000, lspSandbox: "required" }),
}));
vi.mock("@cockpit-context/explore", () => ({
  generateCheckoutSummary: vi.fn(),
  generateRepoMap: vi.fn(),
  runExploreAgent: vi.fn(),
  LspManager: class {
    constructor(readonly options: unknown) {
      state.lspOptions = options;
    }
    stopCheckout = state.stopCheckout;
    get enabled() {
      return false;
    }
    // Started at creation, never awaited: a probe that never settles must not block.
    ready() {
      state.probes += 1;
      return new Promise(() => {});
    }
    status = () => ({
      enabled: false,
      maxServers: 2,
      sandbox: {
        mode: "unavailable",
        reason: "missing",
        detail: "the Landlock helper is not installed",
      },
    });
  },
}));
vi.mock("@cockpit-context/repos", () => ({
  ensureRepository: vi.fn(),
  materializeCheckout: vi.fn(),
  cachedResolveTarget: vi.fn(),
  onCheckoutRemoval: (listener: (ids: readonly string[]) => Promise<void>) => {
    state.listeners.push(listener);
    return () => {};
  },
}));
vi.mock("@cockpit-context/repos/jobs", () => ({ pruneStorageJob: { type: "storage.prune" } }));
vi.mock("@cockpit-context/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-context/jobs")>()),
  enqueueJob: state.enqueueJob,
}));
vi.mock("./engine", () => ({
  createRunEngine: (deps: unknown) => {
    state.createRunEngine(deps);
    state.deps = deps;
    return { deps };
  },
}));

const { getLspStatus, getRunEngine, onSummaryFailure } = await import("./default-engine");

describe("getRunEngine", () => {
  it("creates one engine whose LSP pool stops before checkouts are removed", async () => {
    const engine = getRunEngine();
    expect(getRunEngine()).toBe(engine);
    expect(state.createRunEngine).toHaveBeenCalledOnce();
    expect(state.listeners).toHaveLength(1);
    await state.listeners[0]?.(["k1", "k2"]);
    expect(state.stopCheckout).toHaveBeenCalledWith("k1");
    expect(state.stopCheckout).toHaveBeenCalledWith("k2");
  });

  it("enqueues summaries and prunes on the job table", async () => {
    const deps = state.deps as {
      jobs: { enqueueSummary(p: unknown): Promise<void>; enqueuePrune(): Promise<void> };
    };
    await deps.jobs.enqueueSummary({ checkoutId: "k1", ownerId: "u1" });
    await deps.jobs.enqueuePrune();
    expect(state.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "checkout.summarize" }),
      { checkoutId: "k1", ownerId: "u1" },
    );
    expect(state.enqueueJob).toHaveBeenCalledWith(
      { type: "storage.prune" },
      { reason: "checkout-created", measure: false },
    );
  });

  it("reports failed summary runs to every listener, even when one throws", async () => {
    getRunEngine();
    const deps = state.deps as {
      onSummaryFailed(failure: unknown): Promise<void>;
    };
    const heard: unknown[] = [];
    const offThrowing = onSummaryFailure(() => {
      throw new Error("smtp down");
    });
    const off = onSummaryFailure((failure) => {
      heard.push(failure);
    });
    const failure = { checkoutId: "k1", runId: "r1", ownerId: "u1", error: "model down" };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(deps.onSummaryFailed(failure)).resolves.toBeUndefined();
      expect(heard).toEqual([failure]);
      off();
      offThrowing();
      await deps.onSummaryFailed(failure);
      expect(heard).toHaveLength(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("sandboxes the LSP pool per COCKPIT_CONTEXT_LSP_SANDBOX, starts its probe without awaiting it and reports it", () => {
    getRunEngine();
    expect(state.lspOptions).toEqual({ maxServers: 2, idleMs: 5_000, sandbox: "required" });
    expect(state.probes).toBe(1);
    expect(getLspStatus()).toEqual({
      enabled: false,
      maxServers: 2,
      sandbox: {
        mode: "unavailable",
        reason: "missing",
        detail: "the Landlock helper is not installed",
      },
    });
  });
});
