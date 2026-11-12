import { Button } from "@cockpit-context/ui/components/button";
import { Input } from "@cockpit-context/ui/components/input";
import { Label } from "@cockpit-context/ui/components/label";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthCard, AuthScreen } from "@/components/auth/auth-screen";
import { ClientTile } from "@/components/mcp/client-tile";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import {
  mcpPageHref,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  toMcpPublicClientInfo,
} from "@/lib/mcp-oauth-search";
import { friendly, isRateLimit } from "@/utils/friendly-error";

/**
 * The MCP OAuth login page: Better-Auth's `loginPage` and `postLogin.page`
 * (packages/auth/src/mcp-plugins.ts). Ported from ws-model-proxy.
 *
 * - Anonymous: the client's display-safe name (POST
 *   `/oauth2/public-client-prelogin`, which requires a valid signed query),
 *   then email + password and, when asked, a 2FA code. Each request carries
 *   the signed `oauth_query` (`oauthProviderClient()`), so a successful
 *   sign-in answers with the next step of the authorization — usually the
 *   consent page — and the page follows it.
 * - Signed in: Continue (to consent, with the raw signed query), or sign
 *   out and sign in again. A revoked connection lands here: a fresh session
 *   is a new grant.
 */
export function McpLoginPage({ lang, rawSearch }: { lang: string; rawSearch: string }) {
  const { t } = useTranslation(["auth"]);
  const info = parseMcpOAuthSearch(rawSearch);
  const { state } = useAuthSession();

  if (!info.usable) return <InvalidRequestCard />;
  if (state.status === "pending" || state.status === "error") return <PageSkeleton />;
  if (state.status === "authenticated") {
    return (
      <AuthCard
        title={t("auth:mcpLogin.signedInTitle")}
        description={t("auth:mcpLogin.signedInDescription", { email: state.session.user.email })}
      >
        <Button
          className="min-h-[44px] w-full"
          onClick={() => window.location.assign(mcpPageHref(lang, "mcp-consent", rawSearch))}
        >
          {t("auth:mcpLogin.continue")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px] w-full"
          onClick={() => void authClient.signOut()}
        >
          {t("auth:mcpLogin.switchAccount")}
        </Button>
      </AuthCard>
    );
  }
  return <McpSignIn lang={lang} rawSearch={rawSearch} clientId={info.clientId ?? ""} />;
}

function InvalidRequestCard() {
  const { t } = useTranslation(["auth"]);
  return (
    <AuthCard
      title={t("auth:mcpLogin.invalidTitle")}
      description={t("auth:mcpLogin.invalidDescription")}
    >
      {null}
    </AuthCard>
  );
}

function PageSkeleton() {
  return (
    <AuthScreen>
      <div className="w-full max-w-md space-y-4">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </AuthScreen>
  );
}

/** Follow Better-Auth's next step, or fall back to the consent page. */
function continueAuthorization(data: unknown, lang: string, rawSearch: string) {
  window.location.assign(
    resolveOauthRedirectUrl(data) ?? mcpPageHref(lang, "mcp-consent", rawSearch),
  );
}

function McpSignIn({
  lang,
  rawSearch,
  clientId,
}: {
  lang: string;
  rawSearch: string;
  clientId: string;
}) {
  const { t } = useTranslation(["auth"]);
  const [twoFactor, setTwoFactor] = useState<{ active: boolean; code: string; busy: boolean }>({
    active: false,
    code: "",
    busy: false,
  });
  const prelogin = useQuery({
    queryKey: ["mcp-prelogin-client", clientId, rawSearch],
    retry: false,
    queryFn: async () => {
      const result = await authClient.oauth2.publicClientPrelogin({ client_id: clientId });
      if (result.error) throw result.error;
      return toMcpPublicClientInfo(result.data);
    },
  });

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      if (result.error) {
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:errors.invalidCredentials"),
        );
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setTwoFactor({ active: true, code: "", busy: false });
        return;
      }
      continueAuthorization(result.data, lang, rawSearch);
    },
    validators: {
      onSubmit: z.object({ email: z.email(), password: z.string().min(1) }),
    },
  });

  const verifyTwoFactor = async () => {
    setTwoFactor((current) => ({ ...current, busy: true }));
    const result = await authClient.twoFactor.verifyTotp({ code: twoFactor.code });
    if (result.error) {
      toast.error(t("auth:errors.invalidTotp"));
      setTwoFactor((current) => ({ ...current, busy: false }));
      return;
    }
    continueAuthorization(result.data, lang, rawSearch);
  };

  if (prelogin.isError) return <InvalidRequestCard />;
  const clientName = prelogin.data?.name ?? prelogin.data?.clientId ?? null;

  if (twoFactor.active) {
    return (
      <AuthCard title={t("auth:twoFactor.title")} description={t("auth:twoFactor.description")}>
        <div className="space-y-2">
          <Label htmlFor="mcp-totp-code">{t("auth:fields.verificationCode")}</Label>
          <Input
            id="mcp-totp-code"
            placeholder="000000"
            value={twoFactor.code}
            onChange={(event) =>
              setTwoFactor((current) => ({ ...current, code: event.target.value }))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="text-center text-lg tracking-widest"
          />
        </div>
        <Button
          className="min-h-[44px] w-full"
          disabled={twoFactor.code.length !== 6 || twoFactor.busy}
          onClick={() => void verifyTwoFactor()}
        >
          {twoFactor.busy ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth:mcpLogin.title")} description={t("auth:mcpLogin.description")}>
      {clientName ? (
        <ClientTile name={clientName} caption={t("auth:mcpLogin.clientCaption")} />
      ) : prelogin.isPending ? (
        <Skeleton className="h-[66px] w-full rounded-lg" />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
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
        <form.Subscribe
          selector={(formState) => ({
            canSubmit: formState.canSubmit,
            isSubmitting: formState.isSubmitting,
          })}
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
    </AuthCard>
  );
}
