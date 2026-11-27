import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import copy from "../../../../packages/locales/src/en-US/nav.json";

const boundary = vi.hoisted(() => ({
  refetch: vi.fn(),
  error: { status: 429 } as { status: number } | null,
  cleanups: [] as (() => void)[],
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: null,
      error: boundary.error,
      isPending: false,
      isRefetching: false,
      refetch: boundary.refetch,
    }),
    $store: {
      atoms: {
        session: {
          get: () => ({ data: null, error: boundary.error, isPending: false, isRefetching: false }),
        },
      },
    },
  },
}));
// As in the mounted identity-hook tests, run mount effects without a browser
// DOM, while rendering the actual application adapter and header branches.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useLayoutEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) boundary.cleanups.push(cleanup);
  },
}));
vi.mock("@cockpit-context/ui/components/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  buttonVariants: () => "",
}));
vi.mock("@cockpit-context/ui/components/skeleton", () => ({
  Skeleton: () => <span data-skeleton="true" />,
}));
vi.mock("@cockpit-context/ui/components/sileo", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split(".")
        .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], copy),
  }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: {}, isPending: false }) }));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@/hooks/use-chat-enabled", () => ({ useChatEnabled: () => false }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));

import { resetAuthSessionMemoryForTests } from "@/hooks/use-auth-session";
import { resetDocumentIdentityForTests } from "@/lib/document-identity";
import { resetSessionRetryForTests } from "@/lib/session-retry";
import { MainNav } from "./main-nav";
import UserMenu from "./user-menu";

beforeEach(() => {
  vi.useFakeTimers();
  const events = new EventTarget();
  const target = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", { ...target, visibilityState: "visible" });
  vi.stubGlobal("navigator", { onLine: true });
  resetDocumentIdentityForTests(() => undefined);
  resetAuthSessionMemoryForTests();
  resetSessionRetryForTests();
  boundary.cleanups = [];
  boundary.error = { status: 429 };
  boundary.refetch.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const cleanup of boundary.cleanups) cleanup();
  resetSessionRetryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("unavailable header account", () => {
  it("an initial 429 offers Retry and Sign out, with public nav and no skeletons", () => {
    const html = renderToStaticMarkup(
      <>
        <MainNav />
        <UserMenu />
      </>,
    );
    expect(html).toContain("Account unavailable — Retry");
    expect(html).toContain('aria-label="Sign out"');
    expect(html).not.toContain("data-skeleton");
    expect(html).not.toContain("Projects");
    expect(html).not.toContain("Admin");
  });
  it("two mounted headers register only one automatic retry", async () => {
    renderToStaticMarkup(
      <>
        <MainNav />
        <UserMenu />
      </>,
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(boundary.refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
  });
});
