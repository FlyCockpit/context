import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AdminSetupCard } from "@/components/auth/admin-setup-card";
import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { PasswordHelp } from "@/components/auth/password-help";
import {
  initialTwoFactorState,
  startTwoFactorChallenge,
  TwoFactorChallenge,
} from "@/components/auth/two-factor-challenge";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { clearServerFieldError, setServerFieldError } from "@/lib/form-server-error";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { type SignupMode, signupMode } from "@/lib/signup-mode";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isCredentialRejection } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const [twoFactor, setTwoFactor] = useState(initialTwoFactorState);
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const ssoEnabled = configData?.ssoEnabled ?? false;
  const forceSso = configData?.forceSso === true;
  const ssoProviderName = configData?.ssoProviderName ?? "SSO";
  // The gate below waits for the config, so the sign-up line never flashes
  // the wrong mode.
  const accountMode = signupMode(configData ?? {});
  const emailConfigured = configData?.emailConfigured ?? false;
  // While no administrator exists (no account at all, or accounts but no
  // admin), explain how the operator finishes setup instead of a dead end.
  const adminSetup = configData?.adminSetup;
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  const handleSsoLogin = async () => {
    const result = await authClient.signIn.social({
      provider: "sso",
      callbackURL: postAuthRedirect,
    });
    if (result.error) {
      console.error("[login.sso]", result.error);
      toast.error(t("auth:login.ssoFailed"));
    }
  };

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
    >
      {adminSetup === "configure" || (adminSetup === "bootstrap" && !forceSso) ? (
        // No account exists, so there is nothing to sign in to yet.
        <AdminSetupCard
          state={adminSetup}
          lang={lang}
          redirectTo={redirectTo}
          forceSso={forceSso}
        />
      ) : twoFactor.active ? (
        <TwoFactorChallenge
          twoFactor={twoFactor}
          setTwoFactor={setTwoFactor}
          emailEnabled={emailConfigured}
          postAuthRedirect={postAuthRedirect}
        />
      ) : (
        <AuthCard
          title={t("auth:login.signinTitle")}
          description={
            forceSso
              ? t("auth:login.ssoOnlyDescription", { provider: ssoProviderName })
              : t("auth:login.signinDescription")
          }
        >
          {adminSetup === "locked" ? (
            <p className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
              {t("auth:adminSetup.lockedNotice")}
            </p>
          ) : null}
          {ssoEnabled && (
            <>
              <Button variant="outline" className="min-h-[44px] w-full" onClick={handleSsoLogin}>
                {t("auth:login.ssoContinue", { provider: ssoProviderName })}
              </Button>
              {!forceSso && (
                // Two rules around the label instead of a label masking one
                // rule with `bg-card`: on phones the card is flat, and the mask
                // showed as a box over the page's backdrop.
                <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  <span>{t("auth:login.or")}</span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </div>
              )}
            </>
          )}
          {!forceSso && (
            <SignInForm
              lang={lang}
              redirectTo={postAuthRedirect}
              passwordResetAvailable={emailConfigured}
              onNeeds2FA={() => setTwoFactor(startTwoFactorChallenge())}
            />
          )}
          {forceSso && !ssoEnabled && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {t("auth:login.ssoUnavailable")}
            </div>
          )}
          <SignupEntry mode={accountMode} lang={lang} redirectTo={redirectTo} />
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

/**
 * The line under the sign-in form that says how to get an account: a link to
 * `/signup` while sign-up is open, and the invite-only note when it is closed,
 * so a visitor without an account is never left guessing. (While the
 * first-admin bootstrap is open the page shows `AdminSetupCard` instead.)
 * docs/ui.md § Sign-up modes.
 */
function SignupEntry({
  mode,
  lang,
  redirectTo,
}: {
  mode: SignupMode;
  lang: string;
  redirectTo: string | undefined;
}) {
  const { t } = useTranslation(["auth"]);
  if (mode === "sso") return null;
  if (mode === "closed") {
    return (
      <p className="text-center text-sm text-balance text-muted-foreground">
        {t("auth:signupMode.inviteOnly")}
      </p>
    );
  }
  return (
    // `max-sm:-mt-2`: on phones the link's 44px box may use half of the
    // gap above it (its text sits 12px inside the box), which keeps it
    // above the BottomNav at 320×568.
    <div className="text-center max-sm:-mt-2">
      <Link
        to="/$lang/signup"
        params={{ lang }}
        search={{ redirectTo }}
        className={cn(buttonVariants({ variant: "link" }), "min-h-[44px] whitespace-normal")}
      >
        {mode === "bootstrap" ? t("auth:signupMode.setupHint") : t("auth:login.signupHint")}
      </Link>
    </div>
  );
}

function SignInForm({
  lang,
  redirectTo,
  passwordResetAvailable,
  onNeeds2FA,
}: {
  lang: string;
  redirectTo: string;
  passwordResetAvailable: boolean;
  onNeeds2FA: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["auth"]);
  const passwordInput = useRef<HTMLInputElement>(null);
  // "Not verified yet" is a notice under the email field, not a field error:
  // a field error would keep the form unsubmittable until the email is edited,
  // but the fix happens elsewhere (the link in the inbox) and the same
  // credentials must work right after it.
  const [unverified, setUnverified] = useState(false);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setUnverified(false);
      let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
      try {
        result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        });
      } catch (err) {
        // The request itself failed (server unreachable, offline): say so,
        // and the same credentials can be sent again.
        console.error("[login.signIn]", err);
        toast.error(friendly(err));
        return;
      }
      if (result.error) {
        // `requireEmailVerification` rejects correct credentials on an
        // unverified account. Better-Auth distinguishes this itself, so say so
        // — the generic "email or password doesn't match" sends the user to
        // password reset for a problem a link in their inbox already solves.
        // This leaks nothing: the caller supplied the matching password.
        //
        // `emailVerification.sendOnSignIn` is on, so Better-Auth has already
        // mailed a fresh link by the time we get here — but the original may
        // have expired days ago, so the message under the email field comes
        // with a link to the resend page rather than leaving a dead end if
        // that mail doesn't arrive.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          setUnverified(true);
          return;
        }
        if (!isCredentialRejection(result.error)) {
          // Not about either field (rate limit, server or network trouble):
          // a short-lived notice, and the same credentials can be sent again.
          toast.error(friendly(result.error));
          return;
        }
        // Under the password field (it is the one the user retypes), never
        // saying which of the two was wrong.
        setServerFieldError(form, "password", t("auth:errors.invalidCredentials"));
        passwordInput.current?.focus();
        passwordInput.current?.select();
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        onNeeds2FA();
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      if (redirectTo === `/${lang}/ongoing`) {
        navigate({ to: "/$lang/ongoing", params: { lang } });
      } else {
        window.location.assign(redirectTo);
      }
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        email: z.email(),
        password: z.string().min(8),
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
      <form.Field
        name="email"
        // A wrong email or password is shown under the password; fixing only
        // the email must make the form submittable again.
        listeners={{ onChange: () => clearServerFieldError(form, "password") }}
      >
        {(field) => (
          <div className="space-y-1">
            <TextField
              field={field}
              label={t("auth:fields.email")}
              type="email"
              autoComplete="email"
            />
            {unverified && (
              <p role="alert" className="text-sm text-destructive">
                {t("auth:verifyEmail.notVerified")}
              </p>
            )}
            {unverified && (
              <Link
                to="/$lang/verify-email"
                params={{ lang }}
                // No `ok`: this is a self-navigation, not a verification hop,
                // so the page must show its neutral resend state.
                search={{ error: undefined, ok: undefined }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px] px-0")}
              >
                {t("auth:verifyEmail.resend")}
              </Link>
            )}
          </div>
        )}
      </form.Field>

      {/* Phones: "Forgot password?" sits in the Password label's row (see
          PasswordHelp), so it does not push the sign-up link below the
          BottomNav at 320×568. DOM order is the same at every width:
          password, then the help, then submit. */}
      <div className="relative space-y-4 max-sm:pt-1.5">
        <form.Field name="password">
          {(field) => (
            <TextField
              field={field}
              ref={passwordInput}
              label={t("auth:fields.password")}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>
        <PasswordHelp
          lang={lang}
          redirectTo={redirectTo}
          passwordResetAvailable={passwordResetAvailable}
        />
      </div>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:login.signingIn") : t("auth:login.signIn")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
