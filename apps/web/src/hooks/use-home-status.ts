import { useQuery } from "@tanstack/react-query";

import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

/** The shell refreshes its badge and the Ongoing counts while the app is open. */
const HOME_STATUS_REFRESH_MS = 30_000;

/**
 * `home.status`: the Packages nav badge (pending proposals), the Ongoing
 * page's Getting started progress and its live-run count. One query shared by
 * the sidebar, the bottom nav and the Ongoing page (TanStack Query dedupes
 * it). Runs only for a signed-in session.
 *
 * Polling is per observer — each one runs its own interval — so exactly one
 * caller passes `poll: true`: `BottomNav`, which the `_app` shell mounts on
 * every page (CSS-hidden on desktop, still mounted). Every other caller reads
 * the shared cache that interval keeps fresh.
 */
export function useHomeStatus({ poll = false }: { poll?: boolean } = {}) {
  const { state } = useAuthSession();
  return useQuery({
    ...orpc.home.status.queryOptions(),
    enabled: state.status === "authenticated",
    refetchInterval: poll ? HOME_STATUS_REFRESH_MS : false,
  });
}
