import { createFileRoute, redirect } from "@tanstack/react-router";

import { APP_HOME } from "@/lib/app-home";

/**
 * `/$lang/dashboard` is where people (and other FlyCockpit apps' habits) expect
 * the signed-in home. Context has no dashboard page: its home is `APP_HOME`
 * (lib/app-home.ts), so this route only forwards there: no page, no session
 * lookup. `APP_HOME` sits under the `_auth` gate, which sends a signed-out
 * visitor to sign-in from there. docs/ui.md § Signed-in home.
 */
export const Route = createFileRoute("/$lang/dashboard")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: APP_HOME, params: { lang: params.lang }, replace: true });
  },
});
