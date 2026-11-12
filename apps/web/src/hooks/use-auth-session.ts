import { authClient } from "@/lib/auth-client";
import { type AuthSessionState, getAuthSessionState } from "@/lib/auth-session-state";

import { useNetworkStatus } from "./use-network-status";

/** The sole application adapter for Better Auth's reactive session atom. */
export function useAuthSession(): AuthSessionState {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();

  return getAuthSessionState({
    data: session.data,
    isPending: session.isPending,
    isRefetching: session.isRefetching,
    error: session.error,
    isOnline,
    refetch: session.refetch,
  });
}
