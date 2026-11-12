import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { lazy, Suspense } from "react";

/**
 * `Markdown` pulls in react-markdown and remark-gfm (a large chunk). On the
 * package page it renders only inside the checkout overview dialog, so it is
 * loaded the first time an overview opens rather than with the route. See
 * docs/development.md § Change workflow.
 */
const Markdown = lazy(() => import("@/components/markdown").then((m) => ({ default: m.Markdown })));

/** A few lines of prose while the renderer loads. */
function MarkdownSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export function LazyMarkdown({ content }: { content: string }) {
  return (
    <Suspense fallback={<MarkdownSkeleton />}>
      <Markdown content={content} />
    </Suspense>
  );
}
