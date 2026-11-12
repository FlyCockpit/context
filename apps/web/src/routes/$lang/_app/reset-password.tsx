import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { authClient } from "@/lib/auth-client";
import { parseResetPasswordSearch } from "@/lib/reset-password-search";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/reset-password")({
  validateSearch: parseResetPasswordSearch,
  beforeLoad: async ({ context, params }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ to: "/$lang/settings/security", params: { lang: params.lang } });
    }
    // Same SSO deflection as signup: an SSO-only org has no password flow.
    const cfg = await context.queryClient.ensureQueryData(orpc.appConfig.queryOptions());
    if (cfg.forceSso) {
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: undefined },
      });
    }
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { lang } = Route.useParams();
  const { token, error, invite } = Route.useSearch();
  const {
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  // Better-Auth redirects here with `?error=INVALID_TOKEN` for a bad token; a
  // token that validates on request but is rejected at reset time flips this.
  const [tokenRejected, setTokenRejected] = useState(false);

  const isInvalid = !token || !!error || tokenRejected;

  return (
    <AuthConfigGate
      isPending={configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
      fields={2}
    >
      {isInvalid ? (
        <AuthCard
          title={t("auth:resetPassword.invalidTitle")}
          description={t("auth:resetPassword.invalidDescription")}
        >
          <Link
            to="/$lang/forgot-password"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.requestNewLink")}
          </Link>
        </AuthCard>
      ) : (
        <AuthCard
          title={t(invite ? "auth:resetPassword.inviteTitle" : "auth:resetPassword.title")}
          description={t(
            invite ? "auth:resetPassword.inviteDescription" : "auth:resetPassword.description",
          )}
        >
          <ResetPasswordForm
            lang={lang}
            token={token}
            invite={invite === true}
            onTokenRejected={() => setTokenRejected(true)}
          />
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

function ResetPasswordForm({
  lang,
  token,
  invite,
  onTokenRejected,
}: {
  lang: string;
  token: string;
  invite: boolean;
  onTokenRejected: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["auth", "validation"]);

  const form = useForm({
    defaultValues: { newPassword: "", confirmPassword: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.resetPassword({
        newPassword: value.newPassword,
        token,
      });
      if (result.error) {
        if (isRateLimit(result.error)) {
          toast.error(friendly(result.error));
          return;
        }
        // A rejected token (expired / already used) is the common failure here
        // — surface the invalid state with a path back to forgot-password.
        console.error("[reset-password.reset]", result.error);
        toast.error(t("auth:resetPassword.failed"));
        onTokenRejected();
        return;
      }
      toast.success(t(invite ? "auth:resetPassword.inviteSuccess" : "auth:resetPassword.success"));
      navigate({ to: "/$lang/login", params: { lang }, search: { redirectTo: undefined } });
    },
    validators: {
      // Standard checks (min length, required) localize through the global Zod
      // error map; only the cross-field match needs an explicit message, which
      // lives in the `validation` namespace.
      onSubmit: z
        .object({
          newPassword: z.string().min(12),
          confirmPassword: z.string().min(12),
        })
        .refine((v) => v.newPassword === v.confirmPassword, {
          message: t("validation:passwordsMustMatch"),
          path: ["confirmPassword"],
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
      <form.Field name="newPassword">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:resetPassword.newPasswordLabel")}
            type="password"
            autoComplete="new-password"
          />
        )}
      </form.Field>

      <form.Field name="confirmPassword">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:resetPassword.confirmPasswordLabel")}
            type="password"
            autoComplete="new-password"
          />
        )}
      </form.Field>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting
              ? t("auth:resetPassword.resetting")
              : t(invite ? "auth:resetPassword.inviteSubmit" : "auth:resetPassword.submit")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
