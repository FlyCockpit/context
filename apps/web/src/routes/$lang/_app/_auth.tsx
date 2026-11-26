import { isAdminRole } from "@cockpit-context/auth/roles";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TwoFactorNudge } from "@/components/admin/two-factor-nudge";
import { AppFrame } from "@/components/app-frame";
import { InlineRetry } from "@/components/inline-retry";
import { RouteContentSkeleton } from "@/components/route-content-skeleton";
import { TwoFactorSetupRequired } from "@/components/two-factor-enrollment";
import { resolveRouteSession } from "@/lib/route-session";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { setSessionHint } from "@/lib/session-hint";
import { orpc } from "@/utils/orpc";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

export const Route = createFileRoute("/$lang/_app/_auth")({
  staticData: { pendingFrame: "app" },
  beforeLoad: async ({ location, params, context }) => {
    const decision = decideProtectedRouteAccess(await resolveRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      // Keep the public pages' cookie hint in step with what this gate just
      // learned (lib/session-hint.ts), both ways.
      setSessionHint(context.queryClient, false);
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: location.href },
      });
    }
    setSessionHint(context.queryClient, true);
    return { session: decision.session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { session } = Route.useRouteContext();
  const { lang } = Route.useParams();
  const {
    data: appSettings,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const { t } = useTranslation(["common", "dashboard"]);

  if (isPending) {
    // The sidebar and a skeleton in the shape of the page being opened (the
    // skeleton draws this layout's `app` frame itself).
    return <RouteContentSkeleton />;
  }

  if (isError) {
    return (
      <AppFrame lang={lang}>
        <div className="container mx-auto max-w-5xl px-4">
          <InlineRetry
            className="py-12"
            message={t("dashboard:appSettingsLoadFailed")}
            onRetry={() => refetch()}
          />
        </div>
      </AppFrame>
    );
  }

  // Forced 2FA is on by default for admins, so an unenrolled admin gets an
  // enrollment grace window (`@cockpit-context/auth/two-factor-policy`) before this
  // guard blocks them — otherwise the first admin to sign up would be walled
  // off from the app before ever reaching the enrollment screen. Only the
  // post-grace `blocked` state takes over the layout (no sidebar: nothing
  // behind it is reachable), and the takeover IS the enrollment flow, so
  // nobody is stranded behind it.
  if (twoFactorEnrollmentState(appSettings, session.user).status === "blocked") {
    return <TwoFactorSetupRequired />;
  }

  return (
    <AppFrame lang={lang}>
      {isAdminRole(session.user.role) &&
      twoFactorEnrollmentState(appSettings, session.user).status === "grace" ? (
        <TwoFactorNudge />
      ) : null}
      <Outlet />
    </AppFrame>
  );
}
