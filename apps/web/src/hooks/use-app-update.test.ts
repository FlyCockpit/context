import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  register: vi.fn<(options: { immediate: boolean; onNeedReload: () => void }) => void>(),
  callback: undefined as (() => void) | undefined,
  cleanup: undefined as (() => void) | undefined,
  reload: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: harness.register }));
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (effect: () => () => void) => {
    harness.cleanup = effect();
  },
}));

import { useAppUpdate } from "./use-app-update";

beforeEach(() => {
  vi.clearAllMocks();
  harness.callback = undefined;
  harness.cleanup = undefined;
});
afterEach(() => {
  harness.cleanup?.();
  vi.unstubAllGlobals();
});

function assertSilentRegistration() {
  expect(harness.register).not.toHaveBeenCalled();
  harness.callback?.();
  expect(harness.register).toHaveBeenCalledOnce();
  const options = harness.register.mock.calls[0]?.[0];
  expect(options?.immediate).toBe(true);
  expect(options?.onNeedReload).toBeTypeOf("function");
  options?.onNeedReload();
  expect(harness.reload).not.toHaveBeenCalled();
}

describe("useAppUpdate", () => {
  it("registers at idle and suppresses activated-update reloads", () => {
    vi.stubGlobal("window", {
      requestIdleCallback: (callback: () => void) => {
        harness.callback = callback;
        return 7;
      },
      cancelIdleCallback: harness.cancel,
      location: { reload: harness.reload },
    });
    useAppUpdate();
    assertSilentRegistration();
    harness.cleanup?.();
    expect(harness.cancel).toHaveBeenCalledWith(7);
  });

  it("uses a cancellable timeout when idle callbacks are unavailable", () => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        harness.callback = callback;
        return 8;
      },
      clearTimeout: harness.cancel,
      location: { reload: harness.reload },
    });
    useAppUpdate();
    assertSilentRegistration();
    harness.cleanup?.();
    expect(harness.cancel).toHaveBeenCalledWith(8);
  });
});
