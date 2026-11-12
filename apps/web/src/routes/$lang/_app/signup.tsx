import { BOOTSTRAP_TOKEN_HEADER } from "@cockpit-context/auth/signup-policy";
import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AdminSetupCard } from "@/components/auth/admin-setup-card";
import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { ResendVerification } from "@/components/auth/resend-verification";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/signup")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ context, params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
    // SSO-only orgs have no password signup at all — deflect to login. A
    // closed server renders the "Sign-up is closed" card instead (below), so a
    // shared /signup link explains itself rather than bouncing.
    const cfg = await context.queryClient.ensureQueryData(orpc.appConfig.queryOptions());
    if (cfg.forceSso) {
      throw redirect({ to: "/$lang/login", params: { lang: params.lang }, search });
    }
  },
  component: SignupPage,
});

function SignupPage() {
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common", "privacy"]);
  // Set once the account exists but has no session. With SMTP configured,
  // Better-Auth requires email verification, so a successful signup
  // deliberately does NOT return a session — there is nothing to redirect into
  // yet. The address is kept only to name it back to the user and to target a
  // resend. (Without SMTP signup returns a session and the form navigates.)
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const forceSso = configData?.forceSso === true;
  // Same gate as /$lang/verify-email: resending needs a working mail transport
  // and a password flow to come back to. Without it the card below must not
  // claim a link was sent, or offer a button that can only ever error.
  const canResend = configData?.emailConfigured === true && !forceSso;
  // First-admin setup: no account exists yet, so the form asks for the
  // one-time token from the server log. Required even when open signup is on:
  // the first account must be the administrator's, or the bootstrap closes
  // for good with no administrator.
  const bootstrap = configData?.adminBootstrapSignupEnabled === true;
  const adminSetup = configData?.adminSetup;
  const signupClosed =
    configData?.signupOpen !== true && configData?.adminBootstrapSignupEnabled !== true;
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  let body: ReactNode;
  if (forceSso) {
    body = (
      <AuthCard
        title={t("auth:login.ssoRequiredTitle")}
        description={t("auth:login.ssoRequiredDescription")}
      >
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:login.signIn")}
        </Link>
      </AuthCard>
    );
  } else if (
    adminSetup === "configure" ||
    (adminSetup === "locked" && configData?.signupOpen !== true)
  ) {
    body = <AdminSetupCard state={adminSetup} lang={lang} redirectTo={redirectTo} />;
  } else if (signupClosed) {
    body = (
      <AuthCard
        title={t("auth:signup.closedTitle")}
        description={t("auth:signup.closedDescription")}
      >
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:login.signIn")}
        </Link>
      </AuthCard>
    );
  } else if (pendingEmail) {
    // Terminal state after a successful signup: the account exists but is inert
    // until the emailed link is clicked, so say that plainly instead of dropping
    // the user back on a form or bouncing them off an authenticated route.
    body = (
      <AuthCard
        title={canResend ? t("auth:verifyEmail.sentTitle") : t("auth:verifyEmail.pendingTitle")}
        description={
          canResend
            ? t("auth:verifyEmail.sentDescription", { email: pendingEmail })
            : t("auth:verifyEmail.accountCreatedNoEmail", { email: pendingEmail })
        }
      >
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.signIn")}
        </Link>
        {canResend ? (
          <ResendVerification email={pendingEmail} />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth:verifyEmail.emailUnavailable")}
          </p>
        )}
      </AuthCard>
    );
  } else {
    body = (
      <AuthCard
        title={bootstrap ? t("auth:adminSetup.bootstrapTitle") : t("auth:login.createAccount")}
        description={t(
          bootstrap ? "auth:signup.bootstrapDescription" : "auth:login.createDescription",
        )}
      >
        <SignUpForm
          bootstrap={bootstrap}
          postAuthRedirect={safeRedirectTo(redirectTo, lang)}
          onPendingVerification={setPendingEmail}
        />
        {/* Notice at collection: the privacy notice is one tap away before
            the account (and its personal data) exists. */}
        <p className="text-center text-sm text-muted-foreground">
          {t("privacy:signupNotice")}{" "}
          <Link
            to="/$lang/privacy"
            params={{ lang }}
            className="font-medium text-primary-text underline underline-offset-4 hover:no-underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("privacy:signupLink")}
          </Link>
        </p>
        <div className="text-center">
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo }}
            className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
          >
            {t("auth:login.signinHint")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
    >
      {body}
    </AuthConfigGate>
  );
}

function SignUpForm({
  bootstrap,
  postAuthRedirect,
  onPendingVerification,
}: {
  bootstrap: boolean;
  postAuthRedirect: string;
  onPendingVerification: (email: string) => void;
}) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { name: "", email: "", password: "", bootstrapToken: "" },
    onSubmit: async ({ value }) => {
      const bootstrapToken = value.bootstrapToken.trim();
      const result = await authClient.signUp.email(
        {
          email: value.email,
          password: value.password,
          name: value.name,
        },
        // The first-admin token travels in a header, never in the body.
        bootstrap && bootstrapToken
          ? { headers: { [BOOTSTRAP_TOKEN_HEADER]: bootstrapToken } }
          : undefined,
      );
      if (result.error) {
        console.error("[signup.signUp]", result.error);
        toast.error(
          bootstrap && result.error.code === "FAILED_TO_CREATE_USER"
            ? t("auth:signup.bootstrapRejected")
            : result.error?.status === 409
              ? t("auth:errors.accountAlreadyRegistered")
              : friendly(result.error, t("auth:errors.couldNotCreateAccount")),
        );
        // Better-Auth's database hook rejects signup-disabled attempts with a
        // plain Error, which the sign-up route converts to this generic 422 —
        // the same response for every address, member or not, so reading it
        // reveals nothing about whether an admin already exists (see
        // apps/server/src/signup-gate.ts). Dev-only, and guarded here (not in
        // a shared util) so the hint string tree-shakes out of prod bundles.
        if (import.meta.env.DEV && !bootstrap && result.error?.code === "FAILED_TO_CREATE_USER") {
          toast.error(t("auth:errors.signupDisabledDevHint"));
        }
        return;
      }
      toast.success(t("auth:accountCreatedSuccess"));
      // Without SMTP there is no verification step: Better-Auth signs the new
      // account in and returns its session token. Full navigation (like the
      // login form) so every session-derived query starts fresh.
      if (result.data?.token) {
        window.location.assign(postAuthRedirect);
        return;
      }
      // With SMTP, `requireEmailVerification` means signUp.email returns no
      // session, so anything behind the `_auth` guard would bounce straight back
      // to login. Hand the address up and let the page render the
      // check-your-email state instead.
      onPendingVerification(value.email);
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        name: z.string().min(2),
        email: z.email(),
        password: z.string().min(12),
        bootstrapToken: bootstrap ? z.string().trim().min(1) : z.string(),
      }),
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.name")}
            inputMode="text"
            autoComplete="name"
          />
        )}
      </form.Field>

      <form.Field name="email">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.email")}
            type="email"
            autoComplete="email"
          />
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.password")}
            type="password"
            autoComplete="new-password"
          />
        )}
      </form.Field>

      {bootstrap ? (
        <form.Field name="bootstrapToken">
          {(field) => (
            <TextField
              field={field}
              label={t("auth:fields.bootstrapToken")}
              description={t("auth:signup.bootstrapTokenHelp")}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </form.Field>
      ) : null}

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:login.creatingAccount") : t("auth:login.signUp")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
