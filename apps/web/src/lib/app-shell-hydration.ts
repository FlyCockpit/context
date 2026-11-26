/**
 * Whether the server-rendered app shell has hydrated, so a route guard may
 * change the router's state.
 *
 * `_app` is `ssr: false`: the server sends its pending shell (header, nav, a
 * content skeleton shaped by the URL). React hydrates every Suspense boundary
 * in a later, low-priority pass (OffscreenLane), so the router can run the
 * guards (`Transitioner`'s mount effect) while the shell is still server HTML.
 * The router's stores give React the current state as the "server snapshot"
 * (`@tanstack/react-store` passes `getSnapshot` for both), so a redirect that
 * lands in that window makes React hydrate the shell for the new URL against
 * the old URL's HTML: React error #418 on a signed-out cold load of
 * /settings, or a signed-in one of /signup. `resolveRouteSession` waits here
 * (in parallel with its probe), so every guard decides only after the shell
 * hydrated. docs/development.md § Query cache follows identity.
 */

/** On the `_app` shell frame's root element, in the server HTML and after. */
export const APP_SHELL_ATTRIBUTE = "data-app-shell";

/**
 * A guard waits at most this long. The frame reports in its first effect, so
 * this only matters if that ever stops happening: a late redirect (and a
 * recoverable mismatch) instead of a page stuck on its skeleton.
 */
export const APP_SHELL_HYDRATION_TIMEOUT_MS = 5000;

let hydrated = false;
let waiters: (() => void)[] = [];

/** Called by the app shell frame's mount effect: its markup is React's now. */
export function markAppShellHydrated(): void {
  hydrated = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/**
 * Resolves once no server-rendered app shell is waiting to hydrate: at once
 * on the server, after the first hydration, and when the document holds no
 * app shell (a client navigation from a public page).
 */
export function appShellHydrated(): Promise<void> {
  if (hydrated || typeof document === "undefined") return Promise.resolve();
  if (!document.querySelector(`[${APP_SHELL_ATTRIBUTE}]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(release, APP_SHELL_HYDRATION_TIMEOUT_MS);
    function release() {
      clearTimeout(timer);
      waiters = waiters.filter((waiter) => waiter !== release);
      resolve();
    }
    waiters.push(release);
  });
}

/** Back to a fresh document. Tests only. */
export function resetAppShellHydrationForTests(): void {
  hydrated = false;
  waiters = [];
}
