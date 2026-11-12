import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A minimal hooks runtime standing in for React: the repo has no DOM test
 * renderer, and what this file proves is which renders re-run the search
 * effect — a question of hook slots and dependency comparison, which this
 * harness models the way React does (layout effects commit before passive
 * ones; an effect re-runs when any dependency fails `Object.is`).
 */
const runtime = vi.hoisted(() => {
  type EffectSlot = {
    deps: readonly unknown[] | undefined;
    cleanup: (() => void) | undefined;
  };
  type Pending = { slot: EffectSlot; create: () => (() => void) | undefined };

  const slots: unknown[] = [];
  let cursor = 0;
  let committing = false;
  let dirty = false;
  let layoutQueue: Pending[] = [];
  let passiveQueue: Pending[] = [];
  let renderFn: (() => void) | null = null;

  function depsChanged(
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ) {
    if (!previous || !next) return true;
    return next.some((value, index) => !Object.is(value, previous[index]));
  }

  function effectHook(queue: () => Pending[]) {
    return (create: () => (() => void) | undefined, deps?: readonly unknown[]) => {
      const index = cursor++;
      const existing = slots[index] as EffectSlot | undefined;
      if (existing && !depsChanged(existing.deps, deps)) return;
      const slot: EffectSlot = existing ?? { deps: undefined, cleanup: undefined };
      slot.deps = deps;
      slots[index] = slot;
      queue().push({ slot, create });
    };
  }

  function flush(queue: Pending[]) {
    for (const { slot, create } of queue) {
      slot.cleanup?.();
      slot.cleanup = create() ?? undefined;
    }
  }

  function render() {
    if (!renderFn) return;
    do {
      dirty = false;
      cursor = 0;
      layoutQueue = [];
      passiveQueue = [];
      renderFn();
      committing = true;
      flush(layoutQueue);
      flush(passiveQueue);
      committing = false;
    } while (dirty);
  }

  const react = {
    useState<S>(initial: S) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      const setState = (next: S) => {
        if (Object.is(slots[index], next)) return;
        slots[index] = next;
        if (committing) dirty = true;
        else render();
      };
      return [slots[index] as S, setState] as const;
    },
    useRef<V>(initial: V) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: V };
    },
    useEffect: effectHook(() => passiveQueue),
    useLayoutEffect: effectHook(() => layoutQueue),
  };

  return {
    react,
    mount(fn: () => void) {
      slots.length = 0;
      renderFn = fn;
      render();
    },
    rerender: render,
    unmount() {
      for (const slot of slots) {
        if (slot && typeof slot === "object" && "cleanup" in slot) {
          (slot as EffectSlot).cleanup?.();
        }
      }
      renderFn = null;
      slots.length = 0;
    },
  };
});

vi.mock("react", () => runtime.react);

const { useAsyncSearch } = await import("./use-async-search");

type Fetcher = (query: string, signal: AbortSignal) => Promise<string[]>;

function harness(initialQuery: string, initialFetcher: Fetcher) {
  const props = { query: initialQuery, fetcher: initialFetcher };
  let latest: { results: string[]; isLoading: boolean } = { results: [], isLoading: false };
  runtime.mount(() => {
    latest = useAsyncSearch(props.fetcher, props.query);
  });
  return {
    get state() {
      return latest;
    },
    rerender(next: Partial<typeof props>) {
      Object.assign(props, next);
      runtime.rerender();
    },
  };
}

function recordingFetcher(results: string[] = []) {
  return vi.fn<Fetcher>(async () => results);
}

describe("useAsyncSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    runtime.unmount();
    vi.useRealTimers();
  });

  it("searches once on mount for the initial query", async () => {
    const fetcher = recordingFetcher(["a"]);
    const hook = harness("", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("");
    await vi.runAllTimersAsync();
    expect(hook.state).toEqual({ results: ["a"], isLoading: false });
  });

  it("does not refetch when only the fetcher's identity changes", async () => {
    const first = recordingFetcher();
    const hook = harness("", first);
    const firstSignal = first.mock.calls[0]?.[1];

    const second = recordingFetcher();
    hook.rerender({ fetcher: second });
    hook.rerender({ fetcher: recordingFetcher() });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(firstSignal?.aborted).toBe(false);
  });

  it("searches again with the latest fetcher once the query settles", async () => {
    const first = recordingFetcher();
    const hook = harness("", first);
    const firstSignal = first.mock.calls[0]?.[1];

    const latest = recordingFetcher(["match"]);
    hook.rerender({ query: "a", fetcher: recordingFetcher() });
    hook.rerender({ query: "ab", fetcher: latest });
    await vi.advanceTimersByTimeAsync(299);
    expect(latest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest.mock.calls[0]?.[0]).toBe("ab");
    await vi.runAllTimersAsync();
    expect(hook.state).toEqual({ results: ["match"], isLoading: false });
  });
});
