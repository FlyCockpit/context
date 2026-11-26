import enNav from "@cockpit-context/locales/src/en-US/nav.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { type ComponentType, lazy, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public pages' session-cookie hint as one shared query: seeded by the
 * `_public` layout during SSR, read by the landing redirect and the public
 * header. Uses the real React Query, so "seeded" means what SSR does: the
 * data is in the request's QueryClient before the header renders.
 */
const hint = vi.hoisted(() => ({ getSessionCookieHint: vi.fn(async () => false) }));
vi.mock("@/server/auth-session", () => hint);
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  redirect: (options: Record<string, unknown>) => ({ redirect: options }),
  Link: ({
    to,
    "aria-label": ariaLabel,
    children,
  }: {
    to: string;
    "aria-label"?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@cockpit-context/env/web", () => ({ env: { VITE_APP_NAME: "Cockpit Context" } }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/offline-band", () => ({ OfflineBand: () => null }));
vi.mock("@/components/skip-link", () => ({ SkipLink: () => null }));
vi.mock("@/components/public-footer", () => ({ PublicFooter: () => <footer /> }));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));

const { ensureSessionHint, sessionHintQueryOptions, setSessionHint, SESSION_HINT_QUERY_KEY } =
  await import("./session-hint");
const { PublicShell } = await import("@/components/public-shell");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");
const { Route: LandingRoute } = await import("@/routes/$lang/_public/index");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  hint.getSessionCookieHint.mockReset();
  hint.getSessionCookieHint.mockResolvedValue(false);
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

type BeforeLoad = (ctx: {
  params?: { lang: string };
  context: { queryClient: QueryClient };
}) => Promise<void>;
const beforeLoadOf = (route: unknown) =>
  (route as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad;

function renderHeader(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PublicShell>
          <p>page</p>
        </PublicShell>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** The header action's target, accessible name and visible (not reserved) label. */
function headerAction(html: string) {
  const match = html.match(
    /<a data-to="(\/\$lang\/(?:login|ongoing))" aria-label="([^"]*)">([\s\S]*?)<\/a>/,
  );
  const visible = (match?.[3] ?? "")
    .replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
  return { to: match?.[1], name: match?.[2], visible };
}

describe("session hint query", () => {
  it("asks the server once, then reads the cache (layout seed + landing redirect)", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
    expect(sessionHintQueryOptions().queryKey).toEqual(SESSION_HINT_QUERY_KEY);
  });

  it("never decides on a stale answer: it waits for a fresh one", async () => {
    const queryClient = newClient();
    // Signed out a while ago (older than the staleTime) ...
    queryClient.setQueryData(SESSION_HINT_QUERY_KEY, false, { updatedAt: Date.now() - 120_000 });
    // ... and signed in since, in another tab.
    hint.getSessionCookieHint.mockResolvedValue(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
  });

  it("does not pause while the browser reports offline (it fails fast to signed out)", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    onlineManager.setOnline(false);
    try {
      expect(sessionHintQueryOptions().networkMode).toBe("always");
      hint.getSessionCookieHint.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(ensureSessionHint(newClient())).resolves.toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("reads a failed hint as signed out instead of throwing", async () => {
    hint.getSessionCookieHint.mockRejectedValue(new Error("offline"));
    await expect(ensureSessionHint(newClient())).resolves.toBe(false);
  });

  it("follows what the app's session gate learned", async () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("is seeded by the _public layout's beforeLoad", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    await beforeLoadOf(PublicRoute)({ context: { queryClient } });
    expect(queryClient.getQueryData(SESSION_HINT_QUERY_KEY)).toBe(true);
  });
});

describe("landing redirect", () => {
  it("sends a probably-signed-in visitor to the signed-in home, replacing the entry", async () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    await expect(
      beforeLoadOf(LandingRoute)({ params: { lang: "es-MX" }, context: { queryClient } }),
    ).rejects.toEqual({
      redirect: { to: "/$lang/ongoing", params: { lang: "es-MX" }, replace: true },
    });
    // The layout's seed answered it: no second server call.
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("shows the landing to a visitor without a session cookie, or when the hint fails", async () => {
    await expect(
      beforeLoadOf(LandingRoute)({
        params: { lang: "en-US" },
        context: { queryClient: newClient() },
      }),
    ).resolves.toBeUndefined();
    hint.getSessionCookieHint.mockRejectedValue(new Error("offline"));
    await expect(
      beforeLoadOf(LandingRoute)({
        params: { lang: "en-US" },
        context: { queryClient: newClient() },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("public header, rendered on the server", () => {
  it("with a seeded 'signed in' hint: Open app to the signed-in home", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    expect(headerAction(renderHeader(queryClient))).toEqual({
      to: "/$lang/ongoing",
      name: enNav.userMenu.openApp,
      visible: enNav.userMenu.openApp,
    });
  });

  it("with a seeded 'signed out' hint: Sign in", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, false);
    expect(headerAction(renderHeader(queryClient))).toEqual({
      to: "/$lang/login",
      name: enNav.userMenu.signIn,
      visible: enNav.userMenu.signIn,
    });
  });

  // The 404 has no `_public` route to seed it: the server renders the
  // anonymous header (identical for everyone) and the client asks afterwards.
  it("without a seed (the 404): Sign in, and no server call during the render", () => {
    expect(headerAction(renderHeader(newClient())).to).toBe("/$lang/login");
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("keeps the action's box identical across the swap (no layout shift)", () => {
    const action = (signedIn: boolean) => {
      const queryClient = newClient();
      setSessionHint(queryClient, signedIn);
      const html = renderHeader(queryClient);
      const inner = html.match(
        /<a data-to="\/\$lang\/(?:login|ongoing)"[^>]*>([\s\S]*?)<\/a>/,
      )?.[1];
      // Both labels, one reserved (invisible): the width is the wider one's.
      return [...(inner ?? "").matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]).sort();
    };
    expect(action(true)).toEqual(action(false));
    expect(action(false)).toEqual([enNav.userMenu.openApp, enNav.userMenu.signIn].sort());
  });
});
