import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Input } from "@cockpit-context/ui/components/input";
import { Label } from "@cockpit-context/ui/components/label";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AdminSetupCard } from "@/components/auth/admin-setup-card";
import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isRateLimit } from "@/utils/friendly-error";
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

/**
 * The whole 2FA challenge as one state object (rather than five separate
 * `useState` calls) so a step change — entering the challenge, sending an
 * email code, or backing out — is a single update and a single render, with
 * no way for the pieces to drift apart mid-transition.
 *
 * `otpSent` marks the email-OTP path: once the user requests a code by email
 * we verify against verifyOtp instead of verifyTotp.
 */
const initialTwoFactorState = {
  active: false,
  code: "",
  verifying: false,
  otpSent: false,
  sendingOtp: false,
};

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
  // Default to hiding the sign-up link until the config is known, so it never
  // flashes on a closed server (the user menu does the same).
  const signupAvailable =
    !forceSso &&
    (configData?.signupOpen === true || configData?.adminBootstrapSignupEnabled === true);
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

  const handle2FAVerify = async () => {
    setTwoFactor((s) => ({ ...s, verifying: true }));
    try {
      // When the user requested an emailed code we verify against the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result = twoFactor.otpSent
        ? await authClient.twoFactor.verifyOtp({ code: twoFactor.code })
        : await authClient.twoFactor.verifyTotp({ code: twoFactor.code });
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        toast.error(t("auth:errors.invalidTotp"));
      } else {
        toast.success(t("auth:signedInSuccess"));
        window.location.assign(postAuthRedirect);
      }
    } finally {
      setTwoFactor((s) => ({ ...s, verifying: false }));
    }
  };

  const handleSendEmailOtp = async () => {
    setTwoFactor((s) => ({ ...s, sendingOtp: true }));
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        toast.error(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:twoFactor.couldNotSendCode"),
        );
        return;
      }
      setTwoFactor((s) => ({ ...s, otpSent: true, code: "" }));
      toast.success(t("auth:twoFactor.codeSent"));
    } finally {
      setTwoFactor((s) => ({ ...s, sendingOtp: false }));
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
        <AdminSetupCard state={adminSetup} lang={lang} redirectTo={redirectTo} />
      ) : twoFactor.active ? (
        <AuthCard
          title={t("auth:twoFactor.title")}
          description={
            twoFactor.otpSent
              ? t("auth:twoFactor.emailCodeDescription")
              : t("auth:twoFactor.description")
          }
        >
          <div className="space-y-2">
            <Label htmlFor="totp-code">{t("auth:fields.verificationCode")}</Label>
            <Input
              id="totp-code"
              placeholder="000000"
              value={twoFactor.code}
              onChange={(e) => setTwoFactor((s) => ({ ...s, code: e.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-lg tracking-widest"
              onKeyDown={(e) => {
                if (e.key === "Enter" && twoFactor.code.length === 6) {
                  handle2FAVerify();
                }
              }}
            />
          </div>
          <Button
            className="min-h-[44px] w-full"
            onClick={handle2FAVerify}
            disabled={twoFactor.code.length !== 6 || twoFactor.verifying}
          >
            {twoFactor.verifying ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
          </Button>
          {emailConfigured && (
            <Button
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={handleSendEmailOtp}
              disabled={twoFactor.sendingOtp}
            >
              {twoFactor.sendingOtp
                ? t("auth:twoFactor.sendingCode")
                : twoFactor.otpSent
                  ? t("auth:twoFactor.resendEmailCode")
                  : t("auth:twoFactor.emailMeCode")}
            </Button>
          )}
          <Button
            variant="ghost"
            className="min-h-[44px] w-full"
            onClick={() => setTwoFactor(initialTwoFactorState)}
          >
            {t("auth:twoFactor.back")}
          </Button>
        </AuthCard>
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
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t("auth:login.or")}</span>
                  </div>
                </div>
              )}
            </>
          )}
          {!forceSso && (
            <SignInForm
              lang={lang}
              redirectTo={postAuthRedirect}
              passwordResetAvailable={emailConfigured}
              onNeeds2FA={() => setTwoFactor({ ...initialTwoFactorState, active: true })}
            />
          )}
          {forceSso && !ssoEnabled && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {t("auth:login.ssoUnavailable")}
            </div>
          )}
          {signupAvailable && (
            <div className="text-center">
              <Link
                to="/$lang/signup"
                params={{ lang }}
                search={{ redirectTo }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
              >
                {t("auth:login.signupHint")}
              </Link>
            </div>
          )}
        </AuthCard>
      )}
    </AuthConfigGate>
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

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      if (result.error) {
        // `requireEmailVerification` rejects correct credentials on an
        // unverified account. Better-Auth distinguishes this itself, so say so
        // — the generic "email or password doesn't match" sends the user to
        // password reset for a problem a link in their inbox already solves.
        // This leaks nothing: the caller supplied the matching password.
        //
        // `emailVerification.sendOnSignIn` is on, so Better-Auth has already
        // mailed a fresh link by the time we get here — but the original may
        // have expired days ago, so the toast also offers the resend page
        // rather than leaving a dead end if that mail doesn't arrive.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          toast.error(t("auth:verifyEmail.notVerified"), {
            action: {
              label: t("auth:verifyEmail.resend"),
              onClick: () =>
                navigate({
                  to: "/$lang/verify-email",
                  params: { lang },
                  // No `ok`: this is a self-navigation, not a verification hop,
                  // so the page must show its neutral resend state.
                  search: { error: undefined, ok: undefined },
                }),
            },
          });
          return;
        }
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:errors.invalidCredentials"),
        );
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
            autoComplete="current-password"
          />
        )}
      </form.Field>

      {passwordResetAvailable ? (
        <div className="text-right">
          <Link
            to="/$lang/forgot-password"
            params={{ lang }}
            search={{ redirectTo }}
            className={cn(
              buttonVariants({ variant: "link" }),
              "min-h-[44px] px-0 text-sm text-muted-foreground",
            )}
          >
            {t("auth:login.forgotPassword")}
          </Link>
        </div>
      ) : (
        // No SMTP: there is no reset flow, so say so instead of silently
        // omitting the link (docs/product.md).
        <p className="text-sm text-muted-foreground">{t("auth:login.passwordResetUnavailable")}</p>
      )}

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
