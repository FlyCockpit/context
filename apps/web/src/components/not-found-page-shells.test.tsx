import enErrors from "@cockpit-context/locales/src/en-US/errors.json";
import { createInstance } from "i18next";
import { type ComponentType, lazy, type ReactNode } from "react";
import { prerender } from "react-dom/static";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The 404's title is the page's one h1 in whichever shell renders it: the
 * public shell (an unknown URL, signed in or not: `$lang`'s
 * notFoundComponent) and the app shell (a not-found boundary inside it). The
 * shells' own chrome (header, nav, banners, footer) is rendered for real here
 * and must bring no heading of its own. The settings layout's not-found
 * boundary nests under its own h1 (an h2). Route components are code-split,
 * so renders wait for the split chunk.
 */
const fixture = vi.hoisted(() => ({
  session: "anonymous" as "anonymous" | "authenticated",
  // What the router stores hold once the first load resolved (`_app` shows
  // its outlet only from then on).
  routerState: {
    resolvedLocation: { pathname: "/en-US/nope" },
    location: { pathname: "/en-US/nope", search: {} },
    matches: [],
    status: "idle",
    isLoading: false,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  Outlet: () => <NotFoundOutlet />,
  redirect: () => undefined,
  useParams: () => ({ lang: "en-US" }),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select?: (state: unknown) => unknown } = {}) =>
    select ? select(fixture.routerState) : fixture.routerState,
  useMatch: () => undefined,
  useMatchRoute: () => () => false,
  useLocation: () => ({ pathname: "/en-US/nope" }),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@cockpit-context/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/utils/orpc", () => {
  // Any `orpc.<router>.<procedure>` path, with the option builders the shell uses.
  const leaf = { queryOptions: () => ({}), queryKey: () => [], call: async () => ({}) };
  const node = (): unknown =>
    new Proxy(leaf, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : node()),
    });
  return { orpc: node() };
});
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(),
  getSessionCookieHint: vi.fn(async () => false),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () =>
    fixture.session === "anonymous"
      ? { state: { status: "anonymous" }, actions: { retry: vi.fn() }, meta: {} }
      : {
          state: {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada", role: "user", emailVerified: true } },
          },
          actions: { retry: vi.fn() },
          meta: { isDegraded: false },
        },
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ useReloadOnIdentityChange: () => {} }));
vi.mock("@/i18n", () => ({ default: {}, loadLocaleInto: async () => {} }));

const { default: NotFoundState } = await import("@/components/not-found-state");
function NotFoundOutlet() {
  return <NotFoundState />;
}
const { PublicNotFoundPage } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: SettingsRoute } = await import("@/routes/$lang/_app/_auth/settings");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { errors: enErrors } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function h1s(html: string): string[] {
  expect(html).not.toContain('role="heading"');
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(([, inner = ""]) => inner);
}

async function render(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
  return new Response(prelude).text();
}

const AppLayout = (AppRoute as unknown as { options: { component: () => ReactNode } }).options
  .component;

describe.each(["anonymous", "authenticated"] as const)("404, %s", (session) => {
  it("has exactly one h1 inside the public shell", async () => {
    fixture.session = session;
    const html = await render(<PublicNotFoundPage />);
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(h1s(html)).toEqual([enErrors.pageNotFound.title]);
  });

  it("has exactly one h1 inside the app shell", async () => {
    fixture.session = session;
    const html = await render(<AppLayout />);
    // The real chrome rendered around the page, not just the outlet.
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(h1s(html)).toEqual([enErrors.pageNotFound.title]);
  });
});

describe("404 under the settings layout", () => {
  it("nests under the layout's h1", async () => {
    const { notFoundComponent: SettingsNotFound } = (
      SettingsRoute as unknown as { options: { notFoundComponent: () => ReactNode } }
    ).options;
    const html = await render(<SettingsNotFound />);
    expect(h1s(html)).toEqual([]);
    expect(html).toMatch(new RegExp(`<h2\\b[^>]*>${enErrors.pageNotFound.title}</h2>`));
  });
});
