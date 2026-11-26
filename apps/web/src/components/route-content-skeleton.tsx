import { Card, CardContent, CardHeader } from "@cockpit-context/ui/components/card";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useMatch, useParams, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppFrame } from "@/components/app-frame";
import { SkeletonList } from "@/components/skeleton-list";
import {
  isFramedPage,
  type PendingFrame,
  type PendingLayout,
  type PendingShape,
  type PendingWidth,
  resolvePendingLayout,
} from "@/lib/pending-layout";

// The `PageShell` widths (components/page-shell.tsx), so the skeleton's
// columns line up with the page that replaces it.
const WIDTH_CLASS: Record<PendingWidth, string> = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
};

/**
 * The content-area skeleton for the route that is loading, shaped by its
 * `staticData` (lib/pending-layout.ts). It never draws the shell: the header
 * and the BottomNav are `_app`'s (its pending component renders the same
 * frame around this), and the signed-in sidebar is the real `AppFrame` (the
 * `app` and `admin` frames), so the nav is the real one from the first frame.
 *
 * It is the router's `defaultPendingComponent`, `_app`'s pending content and
 * the `_auth` / admin layouts' loading state.
 */
export function RouteContentSkeleton() {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  // The matches of the location being loaded (a pending route is already in
  // `matches`, with status "pending"), leaf last.
  const matches = useRouterState({ select: (state) => state.matches });
  return (
    <ContentSkeleton
      layout={resolvePendingLayout(matches, routeId)}
      contained={isFramedPage(matches)}
    />
  );
}

/** The skeleton markup for a resolved layout. */
function ContentSkeleton({ layout, contained }: { layout: PendingLayout; contained: boolean }) {
  // The admin and section frames hold the page in their own container (drawn
  // here or already on screen above the boundary); a page directly in the app
  // frame (or in nothing) brings its `PageShell` one.
  let body: ReactNode = (
    <div
      data-route-skeleton={layout.shape}
      aria-busy="true"
      className={cn(
        "space-y-6",
        !contained && ["container mx-auto px-4 py-8", WIDTH_CLASS[layout.width]],
      )}
    >
      <ShapeSkeleton shape={layout.shape} />
    </div>
  );
  // Innermost frame first: a tokens list inside the Access tabs inside the
  // signed-in sidebar.
  for (const frame of [...layout.frames].reverse()) {
    body = (
      <FrameSkeleton frame={frame} width={layout.width}>
        {body}
      </FrameSkeleton>
    );
  }
  return body;
}

function FrameSkeleton({
  frame,
  width,
  children,
}: {
  frame: PendingFrame;
  width: PendingWidth;
  children: ReactNode;
}) {
  const params = useParams({ strict: false });
  if (frame === "app") {
    // The real sidebar (desktop) beside the page: same boxes as the loaded
    // layout, so nothing moves when it arrives.
    return <AppFrame lang={params.lang ?? "en-US"}>{children}</AppFrame>;
  }
  if (frame === "admin") {
    // The admin layout: the same sidebar, a sticky, full-bleed strip of 44px
    // links, then the page in its own `PageShell`.
    return (
      <AppFrame lang={params.lang ?? "en-US"}>
        <div className="min-h-full">
          <div className="border-b">
            <div className="container mx-auto flex max-w-7xl gap-1 overflow-hidden px-4 py-2">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md" />
              ))}
            </div>
          </div>
          <div className={cn("container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[width])}>
            {children}
          </div>
        </div>
      </AppFrame>
    );
  }
  // Access and Settings: a `PageShell` with the section's title, its tabs,
  // then the tab's content.
  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <HeaderSkeleton />
      <div className="-mx-4 flex gap-1 overflow-hidden border-b px-4 pb-2 sm:mx-0 sm:px-0">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-28 shrink-0 rounded-md" />
        ))}
      </div>
      {children}
    </div>
  );
}

function HeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      {action ? <Skeleton className="h-11 w-32" /> : null}
    </div>
  );
}

function ShapeSkeleton({ shape }: { shape: PendingShape }) {
  switch (shape) {
    case "list":
      return (
        <>
          <HeaderSkeleton action />
          <Card>
            <CardHeader className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="p-0">
              <SkeletonList count={4} />
            </CardContent>
          </Card>
        </>
      );
    case "detail":
      return (
        <>
          <HeaderSkeleton action />
          <Skeleton className="h-48 w-full rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </>
      );
    case "form":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full md:h-8" />
              </div>
            ))}
          </div>
          <Skeleton className="h-11 w-32" />
        </>
      );
    case "dashboard":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        </>
      );
  }
}
