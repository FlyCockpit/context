import { appShellHydrated } from "@/lib/app-shell-hydration";
import { admitRouteIdentity, identityVerificationGeneration } from "@/lib/document-identity";
import {
  failedRouteSessionResolution,
  type RouteSessionResolution,
} from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made while no `_app` page was open, or in another tab), the document
 * is replaced and this never settles, so nothing under the guard renders the
 * previous identity's data. It also waits for the server-rendered app shell
 * to hydrate, so a guard's redirect never lands mid-hydration. Every session
 * guard uses this, never `getRouteSession()` alone.
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  // Nothing a guard decides (redirect, not-found, error) may reach the router
  // while the server-rendered app shell is still hydrating
  // (lib/app-shell-hydration.ts). The wait runs alongside the probe, and a
  // failed probe (a transport error) also waits before it reaches the router.
  // Taken before the probe: an identity change announced while it runs (or a
  // 401 with no watcher mounted) is newer than its answer, which then admits
  // nothing: the guard asks again, so a page never renders on an answer that
  // predates a sign-out or switch elsewhere. Bounded: a document still being
  // invalidated after that admits nothing and gets the guard's retryable
  // error state.
  let since = identityVerificationGeneration();
  const [probe] = await Promise.allSettled([getRouteSession(), appShellHydrated()]);
  if (probe.status === "rejected") throw probe.reason;
  let resolution = probe.value;
  for (
    let retry = 0;
    retry < MAX_STALE_REPROBES && since !== identityVerificationGeneration();
    retry++
  ) {
    since = identityVerificationGeneration();
    resolution = await getRouteSession();
  }
  if (since !== identityVerificationGeneration()) return failedRouteSessionResolution();
  await admitRouteIdentity(resolution, since);
  return resolution;
}

/** Probes asked again after an invalidation landed mid-probe. */
const MAX_STALE_REPROBES = 2;
