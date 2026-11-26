/**
 * What a route looks like while it loads, declared on the route itself
 * (`staticData`) so the skeleton the user sees first has the page's shape:
 * a list, a detail view, a form or a dashboard, at the page's width, inside
 * the layout chrome (the signed-in sidebar, the admin strip, the Access and
 * Settings section tabs) that the page sits in.
 * See docs/ui.md § Loading states that look like the app
 *
 *   export const Route = createFileRoute("/$lang/_app/_auth/projects")({
 *     staticData: { pendingShape: "list", pendingWidth: "narrow" },
 *     component: ProjectsPage,
 *   });
 *
 * A layout route that draws its own chrome around its children sets
 * `pendingFrame`; leaf routes set `pendingShape` (default "list") and
 * `pendingWidth` (default "default", the `PageShell` widths).
 */
export type PendingShape = "list" | "detail" | "form" | "dashboard";
export type PendingFrame = "app" | "admin" | "sections";
export type PendingWidth = "narrow" | "default" | "wide";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrame;
  }
}

export type PendingLayout = {
  shape: PendingShape;
  width: PendingWidth;
  frames: PendingFrame[];
};

type MatchLike = {
  routeId: string;
  staticData?: {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrame;
  };
};

/**
 * The skeleton for the matches from `fromRouteId` (the route whose pending
 * boundary is showing) down to the leaf. Frames above that route are already
 * on screen (their layout rendered), so only the ones at or below it are
 * drawn; the leaf decides the shape and width.
 */
export function resolvePendingLayout(
  matches: readonly MatchLike[],
  fromRouteId: string | undefined,
): PendingLayout {
  const start = fromRouteId ? matches.findIndex((match) => match.routeId === fromRouteId) : 0;
  const below = matches.slice(Math.max(start, 0));
  const frames: PendingFrame[] = [];
  for (const match of below) {
    const frame = match.staticData?.pendingFrame;
    if (frame) frames.push(frame);
  }
  const leaf = [...below].reverse().find((match) => match.staticData?.pendingShape);
  const widthMatch = [...below].reverse().find((match) => match.staticData?.pendingWidth);
  return {
    shape: leaf?.staticData?.pendingShape ?? "list",
    width: widthMatch?.staticData?.pendingWidth ?? "default",
    frames,
  };
}

/**
 * Whether the page sits in a frame that brings its own container (the admin
 * strip, the Access and Settings tabs), counting frames already on screen
 * above the pending boundary: the page's skeleton then adds no second
 * `PageShell` container of its own.
 */
export function isFramedPage(matches: readonly MatchLike[]): boolean {
  return matches.some((match) => {
    const frame = match.staticData?.pendingFrame;
    return frame !== undefined && frame !== "app";
  });
}
