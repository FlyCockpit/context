import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionState,
  getAuthSessionState,
  rememberConfirmedAnonymous,
} from "@/lib/auth-session-state";

import { useNetworkStatus } from "./use-network-status";

/**
 * Whether Better Auth's session atom has settled anonymous in this document.
 * Module-level because the atom is: every caller reads the same session, so a
 * component that mounts during a refetch (a navigation from /login to /signup
 * while the tab regains focus) must not see a first load either. Only browser
 * snapshots write it; the server's are always the unresolved initial state.
 */
let confirmedAnonymous = false;

/** The sole application adapter for Better Auth's reactive session atom. */
export function useAuthSession(): AuthSessionState {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();

  const result = getAuthSessionState({
    data: session.data,
    isPending: session.isPending,
    isRefetching: session.isRefetching,
    error: session.error,
    isOnline,
    refetch: session.refetch,
    confirmedAnonymous,
  });
  // A fact about the shared atom, not about this render: idempotent, and the
  // same for every caller that reads this snapshot.
  if (typeof window !== "undefined") {
    confirmedAnonymous = rememberConfirmedAnonymous(confirmedAnonymous, result.state);
  }
  return result;
}

/** Forget the settled state, as a new document would. Tests only. */
export function resetAuthSessionMemoryForTests(): void {
  confirmedAnonymous = false;
}
