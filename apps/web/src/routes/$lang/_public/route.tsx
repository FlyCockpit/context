import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PublicShell } from "@/components/public-shell";

export const Route = createFileRoute("/$lang/_public")({
  component: PublicLayout,
});

// Frame, header, scroller and footer live in PublicShell, which the 404 shares
// (`$lang`'s notFoundComponent).
function PublicLayout() {
  return (
    <PublicShell>
      <Outlet />
    </PublicShell>
  );
}
