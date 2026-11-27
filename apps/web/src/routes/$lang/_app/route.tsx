import { cn } from "@cockpit-context/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { type ReactNode, useCallback } from "react";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import { OfflineBand } from "@/components/offline-band";
import PullToRefresh from "@/components/pull-to-refresh";
import { RouteContentSkeleton } from "@/components/route-content-skeleton";
import { SkipLink } from "@/components/skip-link";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { useReloadOnIdentityChange } from "@/hooks/use-reload-on-identity-change";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";
import { markAppShellHydrated } from "@/lib/app-shell-hydration";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { SessionUnconfirmed } from "@/lib/session-unconfirmed";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  // What a hard refresh paints first. With `ssr: false` the server renders
  // this route's pending component in place of the layout, and the client
  // shows it again until the layout can mount (hydration, the auth check).
  // So it is the real shell (header, sidebar, bottom nav) around a skeleton
  // of the page's content area only: no frame without the nav, and no layout
  // jump when the page arrives; `pnpm check:shell-loading` measures it.
  // See docs/ui.md § Loading states that look like the app
  pendingComponent: AppShellPending,
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  useReloadOnIdentityChange();
  useDocumentLang();
  useUserLocaleSync();
  const queryClient = useQueryClient();

  // Every signed-in page gets pull-to-refresh: mark all cached data stale and
  // refetch what is on screen. A page opts out with
  // `data-pull-to-refresh="off"` (see docs/development.md).
  const handleRefresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);
  // The first load of a page waits on the `_auth` / admin session check. A
  // pending route shows nothing until the router's `pendingMs` (1s) has passed,
  // and on a hard refresh there is no previous page to keep on screen, so the
  // shell would show an empty content area, then the skeleton. Until that
  // first load resolves, the outlet is the page's skeleton; later navigations
  // keep the current page on screen as usual.
  const firstLoadDone = useRouterState({ select: (state) => state.resolvedLocation !== undefined });

  // Until that first load resolves, no guard has admitted anyone yet: the
  // chrome shows no account (lib/session-unconfirmed.ts). The provider stays
  // in place either way, so the frame never remounts.
  return (
    <>
      <SessionUnconfirmed active={!firstLoadDone}>
        <AppShellFrame>
          <PullToRefresh onRefresh={handleRefresh}>
            {firstLoadDone ? <Outlet /> : <RouteContentSkeleton />}
          </PullToRefresh>
        </AppShellFrame>
      </SessionUnconfirmed>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}

/** The shell around the loading page: same frame, content skeleton only. */
function AppShellPending() {
  // It paints before any session guard has admitted anyone: the chrome shows
  // no account until one has (lib/session-unconfirmed.ts).
  return (
    <SessionUnconfirmed>
      <AppShellFrame>
        <RouteContentSkeleton />
      </AppShellFrame>
    </SessionUnconfirmed>
  );
}

/**
 * The app frame, shared by the layout and its pending state so the two are
 * the same boxes: the header and the bottom nav never move when the page
 * replaces its skeleton.
 */
function AppShellFrame({ children }: { children: ReactNode }) {
  const mobileKeyboardOpen = useMobileKeyboard();
  // The first effect of a hydrated (or client-rendered) frame: from here on a
  // route guard may change the URL (lib/app-shell-hydration.ts).
  useMountEffect(markAppShellHydrated);
  return (
    <div
      className={cn(
        // `group/shell`: the top-row bands line up with the sidebar (SIDEBAR_INSET_CLASS).
        "group/shell grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr] md:pb-0",
        // A hard refresh streams this frame as HTML, and the sidebar's markup
        // sits between `<main>` and the page's skeleton: on a slow network the
        // browser would paint a shell with an empty content area and no
        // BottomNav. The frame stays invisible (no layout change) until its
        // last child has arrived, so the first frame is the whole shell.
        "[&:not(:has(>[data-shell-end]))]:invisible",
        !mobileKeyboardOpen && "pb-[calc(var(--bottom-nav-bar)_+_var(--safe-area-bottom))]",
      )}
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
      // APP_SHELL_ATTRIBUTE: what a guard looks for to know a server-rendered
      // shell may still be hydrating.
      data-app-shell=""
    >
      <div>
        <SkipLink />
        <Header />
        <AdminSetupBanner />
        {/* In the top row, above the scroller: it never covers the page or
            the BottomNav. */}
        <OfflineBand />
      </div>
      {/* The page scroller. `[container-type:size]` lets the AppFrame sidebar
          stick at the scroller's height (`100cqh`); it also makes `main` the
          containing block of fixed descendants, so overlays portal out (Base
          UI does) and fixed chrome (BottomNav) stays outside. No
          `scrollbar-gutter: stable`: the banners and sticky sub-navs inside
          the scroller are full-bleed. This shell has no footer: phones get
          the BottomNav. See docs/ui.md § Shell rules */}
      <main
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [container-type:size]"
      >
        {children}
      </main>
      <BottomNav hidden={mobileKeyboardOpen} />
      <span data-shell-end="" hidden />
    </div>
  );
}
