import { type ComponentType, createElement, lazy, type ReactNode } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";

import { useSessionUnconfirmed } from "./session-unconfirmed";

const router = vi.hoisted(() => ({ firstLoadDone: false }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Outlet: () => "page",
  useRouterState: () => router.firstLoadDone,
  // Route components are code-split, so renders wait for the split chunk.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/offline-band", () => ({ OfflineBand: () => null }));
vi.mock("@/components/skip-link", () => ({ SkipLink: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
// The header reads the session through useAuthSession, which masks it here.
vi.mock("@/components/header", () => ({
  default: function Header() {
    return useSessionUnconfirmed() ? "header:unconfirmed" : "header:session";
  },
}));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/route-content-skeleton", () => ({ RouteContentSkeleton: () => "skeleton" }));
vi.mock("@/hooks/use-mount-effect", () => ({ useMountEffect: () => {} }));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ useReloadOnIdentityChange: () => {} }));

const { Route } = await import("@/routes/$lang/_app/route");
const { component, pendingComponent } = (
  Route as unknown as { options: { component: () => ReactNode; pendingComponent: () => ReactNode } }
).options;

async function render(Frame: () => ReactNode): Promise<string> {
  const { prelude } = await prerender(createElement(Frame));
  return new Response(prelude).text();
}

describe("the _app shell before a guard admitted anyone", () => {
  it("the pending shell shows no account", async () => {
    expect(await render(pendingComponent)).toContain("header:unconfirmed");
  });

  it("the layout shows no account until the first load resolves, then the session", async () => {
    router.firstLoadDone = false;
    const first = await render(component);
    expect(first).toContain("header:unconfirmed");
    expect(first).toContain("skeleton");
    router.firstLoadDone = true;
    const loaded = await render(component);
    expect(loaded).toContain("header:session");
    expect(loaded).toContain("page");
  });
});
