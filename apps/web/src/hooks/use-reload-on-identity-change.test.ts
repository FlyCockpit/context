import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  ref: { current: undefined as unknown },
  lastDeps: undefined as unknown[] | undefined,
  state: { status: "pending" } as
    | { status: "pending" }
    | { status: "error" }
    | { status: "anonymous" }
    | { status: "authenticated"; session: { user: { id: string } } },
  reload: vi.fn(),
}));

// Run the hook without a DOM: one persistent ref, and an effect that fires
// whenever its deps change — the same contract React gives it.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => boundary.ref,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const changed =
      boundary.lastDeps === undefined || deps.some((dep, i) => dep !== boundary.lastDeps?.[i]);
    boundary.lastDeps = deps;
    if (changed) effect();
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: boundary.state }),
}));

import {
  markExplicitSignOut,
  sessionIdentity,
  shouldReloadForIdentity,
  useReloadOnIdentityChange,
} from "./use-reload-on-identity-change";

const user = (id: string) => ({ status: "authenticated", session: { user: { id } } }) as const;

function useRenderWith(state: typeof boundary.state) {
  boundary.state = state;
  useReloadOnIdentityChange();
}

describe("sessionIdentity", () => {
  it("maps session states to identities", () => {
    expect(sessionIdentity(user("u1"))).toBe("u1");
    expect(sessionIdentity({ status: "anonymous" })).toBeNull();
    expect(sessionIdentity({ status: "pending" })).toBeUndefined();
    expect(sessionIdentity({ status: "error" })).toBeUndefined();
  });
});

describe("shouldReloadForIdentity", () => {
  it("only reloads when a signed-in user goes away", () => {
    expect(shouldReloadForIdentity(undefined, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", undefined)).toBe(false);
    expect(shouldReloadForIdentity("u1", "u1")).toBe(false);
    expect(shouldReloadForIdentity(null, null)).toBe(false);
    // Anonymous → signed in carries only public data; no reload.
    expect(shouldReloadForIdentity(null, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", null)).toBe(true);
    expect(shouldReloadForIdentity("u1", "u2")).toBe(true);
  });
});

describe("useReloadOnIdentityChange", () => {
  beforeEach(() => {
    boundary.ref.current = undefined;
    boundary.lastDeps = undefined;
    boundary.reload.mockReset();
    vi.stubGlobal("window", { location: { reload: boundary.reload } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not reload on the first known identity or on sign-in", () => {
    useRenderWith({ status: "pending" });
    useRenderWith({ status: "anonymous" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("does not reload when a pending or error blip resolves to the same user", () => {
    useRenderWith(user("u1"));
    useRenderWith({ status: "error" });
    useRenderWith({ status: "pending" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("leaves an explicit sign-out's own page load alone, until it is undone", () => {
    const undo = markExplicitSignOut();
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).not.toHaveBeenCalled();
    undo();
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the user signs out elsewhere or the account switches", () => {
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);

    boundary.ref.current = undefined;
    boundary.lastDeps = undefined;
    useRenderWith(user("u1"));
    useRenderWith({ status: "pending" });
    useRenderWith(user("u2"));
    expect(boundary.reload).toHaveBeenCalledTimes(2);
  });
});
