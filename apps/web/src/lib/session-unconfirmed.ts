import { createContext, createElement, type ReactNode, useContext } from "react";

/** True inside a subtree that must not show who is signed in yet. */
const SessionUnconfirmedContext = createContext(false);

/**
 * Renders its subtree as if the session were still being checked, so
 * `useAuthSession()` reports `pending` there whatever Better Auth's atom
 * holds. The app shell's pending state uses it: it paints before the session
 * guards (`resolveRouteSession`) have admitted anyone, and a document entering
 * the app from a public page can still hold the previous account's session in
 * the atom (another tab switched accounts meanwhile). The account menu and
 * nav show their pending state instead of that account. The layout itself
 * also paints the shell before the first load's guard has resolved
 * (`routes/$lang/_app/route.tsx`): it passes `active` while that holds, so
 * the subtree stays mounted when the guard admits someone.
 * docs/development.md § Query cache follows identity.
 */
export function SessionUnconfirmed({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return createElement(SessionUnconfirmedContext.Provider, { value: active }, children);
}

export function useSessionUnconfirmed(): boolean {
  return useContext(SessionUnconfirmedContext);
}
